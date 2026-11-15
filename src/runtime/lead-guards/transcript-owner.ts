/**
 * @module lead-guards/transcript-owner
 * Read-only transcript queries shared by the two lead guards: "is this entry a real owner message"
 * (a human typed it, not a notification / peer relay / system envelope), "which owner messages exist
 * in the session" (scope guard) and "was the turn that just ended started by the owner" (outcome guard).
 * Every function is fail-open: an unreadable transcript yields `null`/empty, never a throw.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { normalizeWs } from "../../policy/lead-guards/owner-rules";
import { NON_OWNER_PREFIX_RE } from "../../policy/lead-guards/markers";
import { isRecordObject } from "../../util/record-object";
import { forEachJsonlEntry, needles } from "../lifecycle/transcript-scan";

/** First tail window and growth cap for the backward turn scan. */
const TAIL_START_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 64 * 1024 * 1024;

/** Claude Code prepends `<system-reminder>…</system-reminder>` blocks to the owner's text; they are not the owner's words. */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Text blocks of a message content (string, or array of blocks) joined; "" when a `tool_result` block is present. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((b) => isRecordObject(b) && b.type === "tool_result")) return "";
  return content
    .filter((b): b is Record<string, unknown> => isRecordObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n");
}

/** The owner text left once system-reminder blocks are removed, or `null` when nothing human remains. */
function humanText(raw: string): string | null {
  const text = raw.replace(SYSTEM_REMINDER_RE, "").trim();
  return !text || NON_OWNER_PREFIX_RE.test(text) ? null : text;
}

/**
 * The text of a real owner message, or `null` when the entry is anything else. A real owner message is
 * either a non-meta `user` entry typed by a human (`origin.kind === "human"`, or no `origin` at all on
 * older hosts), or an `attachment` `queued_command` the human typed while the lead was working
 * (`humanTurn: true`, human origin). System-reminder blocks are dropped first; a remainder that is a
 * system envelope (`<...>` tags, cross-session relay, compaction summary) is not the owner.
 * @param entry - One parsed transcript line.
 * @returns The owner's text, or `null`.
 */
export function ownerMessageText(entry: unknown): string | null {
  if (!isRecordObject(entry)) return null;
  if (entry.type === "attachment") {
    const a = entry.attachment;
    const human = isRecordObject(a) && a.type === "queued_command" && a.humanTurn === true && isRecordObject(a.origin) && a.origin.kind === "human";
    return human && typeof a.prompt === "string" ? humanText(a.prompt) : null;
  }
  if (entry.type !== "user" || entry.isMeta === true) return null;
  const origin = entry.origin;
  if (isRecordObject(origin) && origin.kind !== "human") return null;
  const message = entry.message;
  return isRecordObject(message) ? humanText(contentText(message.content)) : null;
}

/** True for a `user` entry that is not a tool result (a prompt, notification, relay or reminder that wakes the model). */
function isTriggerEntry(entry: unknown): boolean {
  if (!isRecordObject(entry) || entry.type !== "user" || !isRecordObject(entry.message)) return false;
  const c = entry.message.content;
  return !(Array.isArray(c) && c.some((b) => isRecordObject(b) && b.type === "tool_result"));
}

/**
 * True when at least one of `quotes` appears (whitespace-normalized, verbatim) in a real owner message
 * of the transcript. Streams the whole file once; entries after the first hit are no longer checked.
 * @param transcriptPath - Absolute transcript path.
 * @param quotes - Normalized quotes to look for.
 * @returns `true`/`false`, or `null` when the transcript cannot be read (caller fails open).
 */
export function quoteInOwnerMessages(transcriptPath: string, quotes: readonly string[]): boolean | null {
  let found = false;
  try {
    forEachJsonlEntry(transcriptPath, needles('"type":"user"', '"queued_command"'), (entry) => {
      if (found) return;
      const text = ownerMessageText(entry);
      if (text === null) return;
      const norm = normalizeWs(text);
      if (quotes.some((q) => norm.includes(q))) found = true;
    });
  } catch {
    return null;
  }
  return found;
}

/** Last `bytes` bytes of a file as complete lines (the first partial line dropped unless the window starts at 0). */
function tailLines(path: string, bytes: number): { lines: string[]; wholeFile: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return { lines, wholeFile: start === 0 };
  } finally {
    closeSync(fd);
  }
}

/** True for an assistant entry that ends a turn and carries text (the shape of a Stop's final message). */
function endTurnWithText(entry: unknown): boolean {
  if (!isRecordObject(entry) || entry.type !== "assistant" || !isRecordObject(entry.message)) return false;
  const reason = entry.message.stop_reason;
  return (reason === "end_turn" || reason === "stop_sequence") && contentText(entry.message.content).trim() !== "";
}

/** True when an assistant entry's text and the hook's final message are the same text (normalized; one may be a part of the other). */
function sameMessage(entry: unknown, expected: string): boolean {
  if (!isRecordObject(entry) || !isRecordObject(entry.message)) return false;
  const a = normalizeWs(contentText(entry.message.content));
  const b = normalizeWs(expected);
  return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
}

/**
 * Verdict of one backward pass over transcript `lines` (oldest first): `true` when an owner message
 * opened the turn, `false` only with POSITIVE evidence that notifications/relays/reminders did (a non-owner
 * trigger entry and no owner message since the previous stop), `undefined` when the window ran out. A span
 * with no trigger at all (e.g. the opening message not flushed yet) is never `false`.
 * @param lines - Raw JSONL lines ending at (and normally including) the turn's final message.
 * @param expectedFinal - The hook's `last_assistant_message`: when the transcript's last end_turn text differs, the transcript lags and the verdict is `true` (never block).
 * @returns `true` / `false` as above, or `undefined` when the window holds no previous stop.
 */
function ownerStartedTurnInLines(lines: readonly string[], expectedFinal?: string): boolean | undefined {
  let skippedCurrent = false;
  let sawTrigger = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (ownerMessageText(entry) !== null) return true;
    if (isTriggerEntry(entry)) sawTrigger = true;
    if (endTurnWithText(entry)) {
      if (!skippedCurrent) {
        // The first one met going backwards must be the turn's own final message. When the hook's
        // `last_assistant_message` is known and does not match it, the transcript lags (it still ends on the
        // PREVIOUS stop): nothing can be judged, so report "owner-driven" = never block.
        if (expectedFinal !== undefined && !sameMessage(entry, expectedFinal)) return true;
        skippedCurrent = true;
      } else return sawTrigger ? false : true;
    }
  }
  return undefined;
}

/**
 * Did the turn that just ended start from a real owner message? Walks the transcript backwards from its
 * end, over the span since the previous Stop: an owner message in that span means the final message
 * answers the owner (never a relay); none means the turn was woken by a notification / peer relay.
 * @param transcriptPath - Absolute transcript path.
 * @param expectedFinal - The hook's `last_assistant_message`; a transcript whose last end_turn text differs is lagging (`true`: never block).
 * @returns `true`/`false`, or `null` when undecidable (unreadable file, window cap hit): the caller must not block.
 */
export function turnStartedByOwner(transcriptPath: string, expectedFinal?: string): boolean | null {
  try {
    for (let bytes = TAIL_START_BYTES; bytes <= TAIL_MAX_BYTES; bytes *= 4) {
      const { lines, wholeFile } = tailLines(transcriptPath, bytes);
      const verdict = ownerStartedTurnInLines(lines, expectedFinal);
      if (verdict !== undefined) return verdict;
      if (wholeFile) return null;
    }
  } catch {
    return null;
  }
  return null;
}

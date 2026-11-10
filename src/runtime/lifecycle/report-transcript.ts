/**
 * @module report-transcript
 * Reading a sub-agent transcript (`agent-<id>.jsonl`) for report recovery: the assistant text
 * entries, their fingerprints, and the lookup of the pre-guard report a {@link GuardRecord} points to.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { GuardRecord } from "./report-record";
import { forEachJsonlEntry, needles } from "./transcript-scan";

/** An assistant text entry of a transcript. */
export interface AssistantText {
  uuid: string;
  /** sha256 of each plausible join of the entry's text blocks. */
  hashes: string[];
  text: string;
}

/** sha256 (hex) of the trimmed text. */
export const sha = (text: string): string => createHash("sha256").update(text.trim()).digest("hex");

/** Text blocks of a transcript entry's `message.content`, or `[]`. */
function textBlocks(entry: Record<string, unknown>): string[] {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? [(b as { text: string }).text] : []));
}

/**
 * Ordered assistant text entries of a transcript.
 * @param path - Transcript path.
 * @returns The entries; `null` when unreadable.
 */
export function assistantTexts(path: string): AssistantText[] | null {
  const out: AssistantText[] = [];
  try {
    forEachJsonlEntry(path, needles('"assistant"'), (raw) => {
      const e = raw as Record<string, unknown>;
      if (e.type !== "assistant" || typeof e.uuid !== "string") return;
      const blocks = textBlocks(e);
      if (blocks.length === 0) return;
      out.push({ uuid: e.uuid, hashes: [sha(blocks.join("\n")), sha(blocks.join(""))], text: blocks.join("\n") });
    });
  } catch {
    return null;
  }
  return out;
}

/**
 * The pre-guard report entry of a record: by fingerprint, else by recorded uuid.
 * @param rec - The guard record.
 * @returns The entry; `null` if absent, ambiguous, or the transcript is not exactly `agent-<id>.jsonl`.
 */
export function locateReport(rec: GuardRecord): AssistantText | null {
  if (!rec.transcript || !existsSync(rec.transcript) || basename(rec.transcript) !== `agent-${rec.agentId}.jsonl`) return null;
  const entries = assistantTexts(rec.transcript);
  if (!entries) return null;
  if (rec.hash) {
    const hash = rec.hash;
    // Same fingerprint = same text (the agent may have repeated its report): any hit quotes it faithfully.
    return entries.find((e) => e.hashes.includes(hash)) ?? null;
  }
  return rec.lastUuid ? (entries.find((e) => e.uuid === rec.lastUuid) ?? null) : null;
}

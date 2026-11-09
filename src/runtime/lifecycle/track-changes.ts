import { basename } from "node:path";
import { homedir } from "node:os";
import { attachSystemMessage, contextResponse } from "../../adapters/claude";
import { loadSessionState, sanitizeSessionId, saveSessionState, sessionsDir } from "../home-state";
import { onceExclusive } from "../inject-dedup";
import { BURST_DEDUP_MS } from "../burst-window";
import { sniperRequiredNotice } from "../notices";
import { isCodeFile } from "./code-extensions";
import type { SessionChanges } from "./code-edit-time";
import { isClaudeScratchpad } from "./scratchpad-path";

/** `changes` block persisted in per-session state (counts and file list are always present once tracked). */
type Changes = SessionChanges & { cumulativeCodeFiles: number; modifiedFiles: string[] };

/** Version-bump modules (`__version__.py`, `version.py`, `_version.py`): edited at release time, never a code change to re-verify. */
const VERSION_FILE = /^_{0,2}version_{0,2}\.py$/;

/**
 * Handle PostToolUse Write/Edit: track the cumulative set of modified code
 * files per session and emit the mandatory "SNIPER VALIDATION REQUIRED"
 * additionalContext. Ports `post-tool-use/track-session-changes.py`.
 * @param sessionIdRaw - Raw session id from the payload.
 * @param filePath - The edited file path.
 * @param home - Home dir (defaults to `~`).
 * @param now - Clock (defaults to `Date.now()`).
 * @returns The native hook stdout (possibly empty when not a code file).
 */
export function trackSessionChanges(sessionIdRaw: unknown, filePath: string, home: string = homedir(), now: number = Date.now()): string {
  if (!filePath || !isCodeFile(filePath)) return "";
  const sid = sanitizeSessionId(sessionIdRaw) ?? "unknown";
  const state = loadSessionState(sid, home);
  const prev = (state.changes as Changes | undefined) ?? { cumulativeCodeFiles: 0, modifiedFiles: [] };
  const files = [...prev.modifiedFiles];
  let count = prev.cumulativeCodeFiles;
  if (!files.includes(filePath)) { count += 1; files.push(filePath); }
  // Per-file edit stamp (release gate + verifiedAt cut-off). Version-bump and scratchpad files stay tracked as before but are not stamped, so they never re-arm a gate.
  const editedAt = { ...(prev.editedAt ?? {}) };
  if (!VERSION_FILE.test(basename(filePath)) && !isClaudeScratchpad(filePath)) editedAt[filePath] = now;
  state.changes = {
    cumulativeCodeFiles: count,
    modifiedFiles: files,
    editedAt,
    lastModifiedFile: filePath,
    lastCheck: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
  } satisfies Changes;
  saveSessionState(sid, state, home);
  // Emit the mandatory reminder ONCE per (file+session) burst: the ~11 sibling
  // plugin hooks of one PostToolUse event would otherwise inject it ~11× (token
  // noise). A real re-edit past the window reminds again. See burst-window.
  // Exclusive mode (not the JSON oncePerWindow): this call is exactly the
  // high-concurrency shape that mode is best-effort against under the real
  // ~11-process fan-out (lesson 2026-07-05 16:00).
  if (!onceExclusive(`sniper:${sid}:${filePath}`, BURST_DEDUP_MS, { now, dir: sessionsDir(home) })) return "";
  const fname = basename(filePath);
  const stdout = contextResponse(
    "PostToolUse",
    `SNIPER VALIDATION REQUIRED: Code file '${fname}' was modified. You MUST now run the sniper agent (fuse-ai-pilot:sniper) to validate this modification before continuing. This is mandatory per CLAUDE.md rules.`,
  );
  // User-visible companion to the additionalContext reminder above (which only
  // reaches the agent, never the human) — rides the SAME oncePerWindow gate above,
  // so the ×11 hook fan-out never duplicates it.
  return attachSystemMessage(stdout, sniperRequiredNotice(fname));
}

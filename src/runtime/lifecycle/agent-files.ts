/**
 * Per-agent file attribution for SubagentStop. Uses the shared transcript parser
 * ({@link readAgentToolUses}) to recover the exact set of files a sub-agent wrote
 * via Write/Edit/MultiEdit/NotebookEdit, so the sniper reminder attributes only
 * the files THIS agent touched instead of every file changed in the whole session
 * (which cross-attributes other teammates' work — the bug this fixes).
 */
import { basename } from "node:path";
import { readAgentToolUses } from "./agent-transcript";
import type { SessionChanges } from "./code-edit-time";

/** An `agent_id` safe to use as an object key (id-like characters only; never `__proto__`). */
export function isAgentKey(agentId: unknown): agentId is string {
  return typeof agentId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(agentId) && agentId !== "__proto__";
}

/**
 * Files the PostToolUse hooks recorded for this `agent_id` (hook payloads fired inside a
 * sub-agent carry it). `null` when the id is absent/invalid or nothing was tagged, so the
 * caller can fall back to the session-wide list.
 * @param changes - The persisted session `changes` block.
 * @param agentId - The SubagentStop payload `agent_id`.
 * @returns The agent's tagged files, or `null`.
 */
export function taggedFilesOf(changes: SessionChanges | undefined, agentId: unknown): string[] | null {
  if (!isAgentKey(agentId) || !Object.hasOwn(changes?.agentFiles ?? {}, agentId)) return null;
  const list = changes?.agentFiles?.[agentId];
  return list && list.length > 0 ? list : null;
}

/** Tools whose `input.file_path`/`notebook_path` names a file the agent authored. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Return the distinct file paths written by the sub-agent whose own transcript is
 * at `transcriptPath` (Write/Edit/MultiEdit/NotebookEdit). `null` when unreadable
 * (caller MUST fall back to the session-wide list — no regression); a possibly-
 * empty array when parsed (empty = authored nothing, so it should NOT be told to
 * validate files other agents changed).
 * @param transcriptPath - Absolute path to the sub-agent's own `.jsonl` transcript.
 * @returns Distinct written paths (order-preserving), or `null` when unreadable.
 */
export function filesWrittenByAgent(transcriptPath: string | undefined): string[] | null {
  const uses = readAgentToolUses(transcriptPath);
  if (uses === null) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of uses) {
    if (!WRITE_TOOLS.has(u.name)) continue;
    const fp = u.input?.file_path ?? u.input?.notebook_path;
    if (typeof fp === "string" && fp && !seen.has(fp)) { seen.add(fp); out.push(fp); }
  }
  return out;
}

/**
 * Filter `sessionFiles` down to the ones this agent actually wrote. Matches the
 * exact recorded string first, then tolerantly on `basename` so a relative-vs-
 * absolute drift between the PostToolUse record and the transcript input never
 * loses an owned file.
 * @param sessionFiles - Session-wide modified files.
 * @param written - Paths the agent wrote (from {@link filesWrittenByAgent}).
 * @returns The subset of `sessionFiles` attributable to this agent.
 */
export function attributeFiles(sessionFiles: readonly string[], written: readonly string[]): string[] {
  const exact = new Set(written);
  const bases = new Set(written.map((f) => basename(f)));
  return sessionFiles.filter((f) => exact.has(f) || bases.has(basename(f)));
}

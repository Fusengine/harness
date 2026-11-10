import { homedir } from "node:os";
import { loadSessionState, sanitizeSessionId } from "../home-state";

/** Shape of the `changes` block persisted in per-session state (shared by the track writer and the gates). */
export interface SessionChanges {
  cumulativeCodeFiles?: number;
  modifiedFiles?: string[];
  /** Last CODE edit time (epoch ms) per file path, stamped by `trackSessionChanges`. */
  editedAt?: Record<string, number>;
  /** Files each sub-agent wrote, keyed by the PostToolUse `agent_id` (per-agent attribution at SubagentStop). */
  agentFiles?: Record<string, string[]>;
  /** `<agent_id>\0<file>` → epoch ms of the last sniper demand: a file is demanded once PER AGENT until it is edited again (replaces masking through the shared counter). */
  remindedAt?: Record<string, number>;
  lastModifiedFile?: string;
  lastCheck?: string;
}

/**
 * Epoch-ms of the most recent CODE edit of a session (0 when none recorded).
 * Reads the per-file `editedAt` stamps; a legacy block without stamps falls back
 * to `lastCheck` (ISO, written by the same hook). Only code files are ever
 * tracked, so version-bump / JSON / MD edits never move this value.
 * @param sessionIdRaw - Raw session id from the payload.
 * @param home - Home dir (defaults to `~`).
 * @returns Epoch ms of the latest code edit, or 0.
 */
export function lastCodeEditAt(sessionIdRaw: unknown, home: string = homedir()): number {
  const sid = sanitizeSessionId(sessionIdRaw);
  if (!sid) return 0;
  const changes = loadSessionState(sid, home).changes as SessionChanges | undefined;
  // `editedAt` present (even empty) = the stamping writer ran: a version-bump-only session has no stamp and must NOT fall back to lastCheck.
  if (changes?.editedAt) {
    const stamps = Object.values(changes.editedAt).filter((n) => Number.isFinite(n));
    return stamps.length > 0 ? Math.max(...stamps) : 0;
  }
  const legacy = changes?.lastCheck ? Date.parse(changes.lastCheck) : NaN;
  return Number.isFinite(legacy) ? legacy : 0;
}

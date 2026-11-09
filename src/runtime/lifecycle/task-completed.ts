import { basename, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { contextResponse, systemMessage } from "../../adapters/claude";
import { resolveMaxLines } from "../../config/limits";
import { resolveTtlSec } from "../../config/ttl";
import { countLines } from "../../policy/file-size";
import { loadSessionState, sanitizeSessionId } from "../home-state";
import { trackFile } from "../paths";
import { freshReceiptFromFile, verifiedAtFromFile } from "../../tracking/receipts";
import { projectStateDir } from "../project-state-dir";
import type { SessionChanges } from "./code-edit-time";
import { isClaudeScratchpad } from "./scratchpad-path";
import { receiptHint } from "./receipt-hint";
import { CODE_EXTENSIONS } from "./code-extensions";
import { stopNoticeOnce, stopReceiptDue, stopSolidMessage, stopSolidResponse } from "./stop-notice";

/** Freshness multiple on `FUSE_ENFORCE_TTL_SEC` for receipts (no new env var); a tsc+test run precedes the "done" by more than one edit window. */
const RECEIPT_TTL_MULTIPLIER = 5;

/** Files modified during the session, persisted by {@link trackSessionChanges}. */
type Changes = SessionChanges;

/** The modified files that are code (by extension) — the receipt gate's trigger set. Session-scratchpad probes (throwaway, real Claude Code path only) never trigger it. */
function codeFiles(files: string[]): string[] {
  return files.filter((fp) => CODE_EXTENSIONS.has(extname(fp)) && !isClaudeScratchpad(fp));
}

/**
 * Refuse completion when code files changed but no fresh, passing verification
 * receipt (`tsc`/test, exit 0, zero failures, within TTL×{@link RECEIPT_TTL_MULTIPLIER})
 * exists in the signed track. TaskCompleted does NOT honor `decision:"block"`
 * (verified against the official hooks docs — `TeammateIdle/TaskCreated/
 * TaskCompleted` are excluded from that list); the documented stdout refusal is
 * `{"continue":false,"stopReason":…}`, which halts the teammate with the reason
 * shown to the user. Returns that JSON, or `null` when the session is clear.
 */
function receiptGate(sid: string, files: string[], editedAt: Record<string, number>, now: number, stateDir: string, cwd: string): string | null {
  const code = codeFiles(files);
  if (code.length === 0) return null;
  const windowMs = resolveTtlSec(process.env) * 1000 * RECEIPT_TTL_MULTIPLIER;
  const track = trackFile(sid, stateDir);
  // verifiedAt cut-off: a file edited after the newest green run STARTED is unverified, however fresh that run is.
  const verifiedAt = verifiedAtFromFile(track);
  const stale = verifiedAt !== null && code.some((f) => (editedAt[f] ?? -Infinity) > verifiedAt);
  if (stale) return refusal(code, cwd);
  if (freshReceiptFromFile(track, windowMs, now)) return null;
  // Past the TTL: still verified when EVERY code file has an edit stamp at or before the green run (modifiedFiles is never cleared; legacy unstamped files keep the TTL rule).
  if (verifiedAt !== null && code.every((f) => editedAt[f] !== undefined)) return null;
  return refusal(code, cwd);
}

/** The documented `TaskCompleted`/`Stop` refusal JSON for unverified code. */
function refusal(code: string[], cwd: string): string {
  const stopReason =
    "VERIFICATION RECEIPT REQUIRED: code files changed but no fresh passing verification receipt " +
    "exists. " + receiptHint(cwd, code);
  return JSON.stringify({ continue: false, stopReason });
}

/**
 * Re-count physical lines of every modified code file and collect SOLID
 * violations (`<basename>: <n> lines (max <max>)`) for those exceeding `max`.
 * @param files - Candidate modified file paths.
 * @param max - The SOLID line ceiling.
 * @returns The list of violation strings (empty when all files comply).
 */
function collectViolations(files: string[], max: number): string[] {
  const violations: string[] = [];
  for (const fp of files) {
    if (!CODE_EXTENSIONS.has(extname(fp)) || !existsSync(fp)) continue;
    try {
      const lines = countLines(readFileSync(fp, "utf-8"));
      if (lines > max) violations.push(`${basename(fp)}: ${lines} lines (max ${max})`);
    } catch { /* unreadable file — skip, matches Python's OSError pass */ }
  }
  return violations;
}

/**
 * Handle TaskCompleted (ports `task-completed/validate-task-solid.py` + the
 * receipt gate); also reused verbatim for Codex's `Stop` via {@link stopCore}
 * (Codex never emits `TaskCompleted`) — `event` stamps the real hook name.
 * @param payload - The TaskCompleted/Stop payload (`task_id`, `task_subject`, `session_id`).
 * @param event - The hook event name to stamp on the SOLID-violation response (default `TaskCompleted`).
 * @param id - Harness adapter id (Stop only: shapes the once-per-session notice; TaskCompleted output is unchanged).
 * @returns The native hook stdout, or `""` when the session is clean.
 */
export function validateTaskSolid(payload: Record<string, unknown>, home: string = homedir(), now: number = Date.now(), stateDir: string = projectStateDir(process.cwd()), event: string = "TaskCompleted", id: string = "claude-code"): string {
  const sid = sanitizeSessionId(payload.session_id ?? "unknown");
  if (!sid) return "";
  const changes = loadSessionState(sid, home).changes as Changes | undefined;
  const files = changes?.modifiedFiles ?? [];
  const editedAt = changes?.editedAt ?? {};
  if (files.length === 0) return "";
  const max = resolveMaxLines();
  const violations = collectViolations(files, max);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  if (event === "Stop") {
    // Stop runs every turn over the same session file list. Receipt refusal: periodic
    // (lessons-reminder cadence) until a passing receipt lands. SOLID: once, re-armed on change.
    if (violations.length === 0) {
      const verdict = receiptGate(sid, files, editedAt, now, stateDir, cwd);
      return verdict && stopReceiptDue(sid, stateDir, now) ? verdict : "";
    }
    const msg = stopSolidMessage(violations, max);
    if (!stopNoticeOnce(sid, `${msg}\n${codeFiles(files).join("\n")}`, stateDir, now)) return "";
    return stopSolidResponse(id, msg);
  }
  if (violations.length === 0) return receiptGate(sid, files, editedAt, now, stateDir, cwd) ?? "";
  const taskId = String(payload.task_id ?? "");
  const subject = String(payload.task_subject ?? "");
  const msg =
    `SOLID VIOLATION in task '${subject}' (${taskId}): ` +
    `${violations.length} file(s) exceed ${max} lines: ` +
    violations.slice(0, 5).join("; ");
  // TaskCompleted rejects `hookSpecificOutput` (same gap as TeammateIdle) — ride `systemMessage`; `Stop` keeps `additionalContext`, which it DOES accept.
  return event === "TaskCompleted" ? systemMessage(msg) : contextResponse(event, msg);
}

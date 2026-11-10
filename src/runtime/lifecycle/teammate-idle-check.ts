/**
 * @module teammate-idle-check
 * TeammateIdle anti-"false done": alongside the existing sniper suggestion
 * ({@link validateTeammateOutput}), verify that the files this teammate ANNOUNCED
 * (session-changes `modifiedFiles`) actually exist on disk. A claimed deliverable
 * missing on disk is a mechanically-verifiable false-done signal → warn the lead.
 * Deduped across the fan-out; silent when nothing is verifiable. Fail-open.
 *
 * Claude-Code-only: no equivalent `TeammateIdle` hook exists on Codex or Hermes,
 * so this handler is never reached through those adapters.
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { systemMessage } from "../../adapters/claude";
import { loadSessionState, sanitizeSessionId } from "../home-state";
import { oncePerWindow } from "../inject-dedup";
import { projectStateDir } from "../project-state-dir";
import { notify } from "../notifications";
import { validateTeammateOutput } from "./teammate-idle";

/** Re-warn about the same idle teammate at most once per 30s (fan-out + retries). */
const IDLE_DEDUP_MS = 30_000;

/** The `changes` block written by `track-changes.ts` into unified session state. */
interface Changes { modifiedFiles?: string[]; }

/** Announced files (session changes) that are ABSENT on disk (the false-done set). */
function missingDeliverables(sessionId: string, home: string): string[] {
  const changes = loadSessionState(sessionId, home).changes as Changes | undefined;
  return (changes?.modifiedFiles ?? []).filter((f) => typeof f === "string" && f !== "" && !existsSync(f));
}

/**
 * Handle TeammateIdle: merge the existing sniper suggestion with a missing-
 * deliverable warning (deduped) into one advisory `systemMessage`, or "" when
 * neither fires. TeammateIdle rejects `hookSpecificOutput` (no `additionalContext`
 * channel) — `systemMessage` is the only user-visible, non-blocking channel it
 * accepts.
 * @param data - The raw TeammateIdle payload (`teammate_name`, `session_id`).
 * @param cwd - Project root (state dir for the dedup sidecar).
 * @param home - Home dir (defaults to `~`).
 * @param now - Clock (defaults to `Date.now()`).
 * @returns The native hook stdout, or "".
 */
export function teammateIdleContext(data: Record<string, unknown>, cwd: string, home: string = homedir(), now: number = Date.now()): string {
  const sniper = validateTeammateOutput(data, home);
  const sessionId = sanitizeSessionId(data.session_id);
  const teammate = String(data.teammate_name ?? data.team_name ?? "unknown");
  let notice = "";
  if (sessionId) {
    const missing = missingDeliverables(sessionId, home);
    if (missing.length > 0 && oncePerWindow(`idle:${sessionId}:${teammate}`, IDLE_DEDUP_MS, { now, dir: projectStateDir(cwd) })) {
      notice = `Teammate '${teammate}' idle but expected deliverable(s) not found on disk: ${missing.slice(0, 5).join(", ")} — verify before treating as done.`;
    }
  }
  const merged = [sniper, notice].filter(Boolean).join("\n\n");
  if (!merged) return "";
  // An actionable idle signal (false-done or sniper suggestion) warrants human
  // attention — voice the "human" sound (fire-and-forget, fail-open no-op).
  notify("human");
  return systemMessage(merged);
}

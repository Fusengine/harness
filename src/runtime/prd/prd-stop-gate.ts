/**
 * @module prd-stop-gate
 * Block-once gate for the LEAD's `Stop` event when the router carries an
 * unresolved PRD cross-check violation (design doc §2.5). SYNC, same
 * one-shot idiom as {@link prdSubagentStopGate}, keyed `sessionId:Stop`
 * instead of per-agent. Covers Codex too — its `Stop` already routes to
 * `stopCore` under `scope === "core"`.
 */
import { dirname } from "node:path";
import { harnessHomeSegment } from "../../policy/apex-target";
import {
  canPromoteRouterEntry, hasAnyViolations, isCompacted, isPrdEnabled, prdProjectRoot,
  readRouterSync, readTaskFileSync, subTasksOf, type PrdRouter, type PrdTaskFile,
} from "../../policy/prd";
import { journalLogPath, readTrackSync } from "../../tracking/track-compact";
import { trackJournalEnabled } from "../../tracking/store";
import { appendEvent } from "../../tracking/track-journal";
import { diffTrackEvents } from "../../tracking/track-diff";
import { prdAlreadyBlocked, recordPrdStopBlocked, type SessionTrack } from "../../tracking/session-state";
import { signTrack, writeLastNonce } from "../../tracking/integrity";
import { withTrackLockSync } from "../../tracking/track-lock-sync";
import { atomicWrite } from "../../util/json-io";
import { blockResponse, contextResponse } from "../../adapters/claude";
import { respond } from "../respond";

const REASON = "PRD cross-check found unresolved violation(s): a task/sub-task is marked validated without a matching done report. Run `harness prd status` for details.";

/** Sync twin of `readAllTaskFiles` (lot A only exposes the async variant). */
function readAllTaskFilesSync(root: string, homeSeg: string, router: PrdRouter): Record<string, PrdTaskFile | null> {
  const out: Record<string, PrdTaskFile | null> = {};
  for (const [task, entry] of Object.entries(router)) out[task] = readTaskFileSync(root, homeSeg, entry.prd);
  return out;
}

/**
 * Persist the one-shot block marker on the SAME side `trackJournalEnabled()`
 * reads from. Twin of `prd-subagent-stop.ts`'s own `persistStopBlocked`
 * (intentionally duplicated, not cross-imported — same SOLID file-size
 * discipline as this module's other duplicated helpers, e.g.
 * `readAllTaskFilesSync`). Bug this fixes: the old code always appended to
 * the journal regardless of mode, but `readTrackSync(file,
 * trackJournalEnabled())` never folds the log when `FUSE_TRACK_JOURNAL=0`
 * (track-compact.ts) — so a legacy replay never saw the marker and
 * re-blocked the lead's Stop on every call.
 */
function persistStopBlocked(trackFilePath: string, track: SessionTrack, key: string, now: number): void {
  if (trackJournalEnabled()) {
    const next = recordPrdStopBlocked(track, key, now);
    for (const ev of diffTrackEvents(track, next, now)) appendEvent(journalLogPath(trackFilePath), ev.field, ev.op, ev.value, ev.ts);
    return;
  }
  withTrackLockSync(dirname(trackFilePath), () => {
    const fresh = readTrackSync(trackFilePath, false); // reload under lock: avoid clobbering a concurrent legacy RMW
    const envelope = signTrack(recordPrdStopBlocked(fresh, key, now));
    atomicWrite(trackFilePath, JSON.stringify(envelope, null, 2));
    writeLastNonce(envelope.nonce);
  });
}

/** Task names whose task-PRD is fully validated (every agent, every sub-task) but not yet compacted (`prd-compact.ts`'s own per-agent test, applied task-wide). */
function compactableTasks(router: PrdRouter, taskFiles: Record<string, PrdTaskFile | null>): string[] {
  const ready: string[] = [];
  for (const task of Object.keys(router)) {
    const taskFile = taskFiles[task];
    if (!taskFile || canPromoteRouterEntry(taskFile)) continue; // missing/unparseable, or already fully compacted
    const fullyValidated = Object.values(taskFile).every((entry) => {
      if (isCompacted(entry)) return true;
      const subs = Object.values(subTasksOf(entry));
      return subs.length > 0 && subs.every((s) => s.status === "validated");
    });
    if (fullyValidated) ready.push(task);
  }
  return ready;
}

/** Names the compactable task(s) and the exact `harness prd compact` invocation (verified against `cli/prd/compact.ts`'s own usage string). */
function compactHintText(tasks: string[]): string {
  if (tasks.length === 1) return `PRD task "${tasks[0]}" is fully validated and ready to compact. Run \`harness prd compact ${tasks[0]}\`.`;
  return `PRD tasks fully validated and ready to compact: ${tasks.join(", ")}. Run \`harness prd compact <task>\` for each.`;
}

/**
 * Non-blocking "ready to compact" hint. Target-agnostic by design: an id
 * allowlist here would silently go stale the day a target's real Stop wiring
 * changes, so this mirrors the SAME per-target form choice as the block path
 * directly below instead of hardcoding one target — kimi/gemini-cli/cline
 * get their own native `respond()` inform envelope, everyone else gets the
 * `Stop` `additionalContext` channel. Whether this function is ever REACHED
 * for a given id is a wiring question, not a code question: measured live
 * against the real hooks.json this project ships (claude-plugins/
 * codex-plugins/kimi-code-plugins) plus each target's own hook docs —
 * Codex's Stop wiring is a plain `hook codex core` with no short-circuit;
 * claude-code's core-guards hooks.json carries a second Stop entry WITHOUT
 * `--sound` that reaches this gate via `src/runtime/lifecycle/dispatch.ts`
 * (the `--sound stop` entry only plays the sound in `maybePlaySound()`);
 * Kimi's Stop hook carries `--sound stop`, which exits in `maybePlaySound()`
 * (`src/cli/hook-sound.ts`) before stdin is ever read, and
 * hermes/gemini-cli/cline have no event literally named
 * `Stop` in their own documented hook taxonomy at all — see prd.md's Known
 * limitations for the full measurement. One-shot per session, on a marker
 * key DISTINCT from the block-once key so neither shadows the other.
 * @param id - Harness target id.
 * @param payload - The raw Stop hook payload.
 * @param router - The parsed router.
 * @param taskFiles - Every router task's parsed task-PRD (or `null`).
 * @param track - The current session track.
 * @param trackFilePath - The session track file path.
 * @param now - Event clock.
 * @returns The native non-blocking stdout (once per session), else `""`.
 */
function compactReminder(
  id: string, payload: Record<string, unknown>, router: PrdRouter,
  taskFiles: Record<string, PrdTaskFile | null>, track: SessionTrack, trackFilePath: string, now: number,
): string {
  const ready = compactableTasks(router, taskFiles);
  if (ready.length === 0) return "";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const key = `${sessionId}:StopCompactHint`;
  if (prdAlreadyBlocked(track, key)) return "";
  persistStopBlocked(trackFilePath, track, key, now);
  const text = compactHintText(ready);
  if (id === "kimi" || id === "gemini-cli" || id === "cline") {
    return respond(id, { kind: "inform", title: "PRD compact", reason: text }, "Stop");
  }
  return contextResponse("Stop", text);
}

/**
 * Run the PRD lead-Stop block-once gate.
 * @param payload - The raw Stop hook payload.
 * @param cwd - Project root.
 * @param id - Harness target id.
 * @param trackFilePath - The session track file path.
 * @param now - Event clock.
 * @returns The native block stdout (once per session); else the compact
 * hint (once per session, whichever ids' real Stop wiring reaches it); else `""`.
 */
export function prdStopGate(payload: Record<string, unknown>, cwd: string, id: string, trackFilePath: string, now: number): string {
  if (!isPrdEnabled(cwd, id)) return "";
  if (id === "cursor") return ""; // `stop` is Cursor's terminal observation event, not gated today (design doc §5 table).
  const root = prdProjectRoot(cwd);
  const homeSeg = harnessHomeSegment(id);
  const router = readRouterSync(root, homeSeg);
  if (!router) return "";
  const track = readTrackSync(trackFilePath, trackJournalEnabled());
  // Two independent violation sources, per the design doc: (a) unresolved
  // `prdViolations` already journaled by the PostToolUse cross-check
  // (§2.2 — `hasAnyViolations` has no track access, so THIS is that half),
  // (b) `hasAnyViolations` itself — a router entry marked `validated` whose
  // task-PRD isn't actually fully validated.
  const trackHasViolations = (track.prdViolations?.length ?? 0) > 0;
  if (!trackHasViolations) {
    const taskFiles = readAllTaskFilesSync(root, homeSeg, router);
    if (!hasAnyViolations(router, taskFiles)) return compactReminder(id, payload, router, taskFiles, track, trackFilePath, now);
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const key = `${sessionId}:Stop`;
  if (prdAlreadyBlocked(track, key)) return "";
  persistStopBlocked(trackFilePath, track, key, now);

  // gemini-cli/cline: route through respond() for their own native block
  // envelope (see prd-subagent-stop.ts's identical routing comment for the
  // full rationale — claude-code/codex/hermes stay on blockResponse
  // unchanged, respond() cannot reproduce their byte-identical shape here).
  if (id === "kimi" || id === "gemini-cli" || id === "cline") {
    return respond(id, { kind: "block", title: "PRD cross-check", reason: REASON }, "Stop");
  }
  return blockResponse(REASON);
}

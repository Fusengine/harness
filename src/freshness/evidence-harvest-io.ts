/**
 * SubagentStop wiring for {@link harvestAgentEvidence}. The core SubagentStop
 * dispatch (`runtime/lifecycle/dispatch.ts`) is SYNCHRONOUS and runs in a
 * short-lived hook process, so this does SYNC track I/O (load → harvest → save)
 * rather than the async `loadTrack`/`saveTrack`: a floating async write could be
 * dropped before the process exits. Mirrors the sync read precedent in
 * `policy/design/skill-evidence.ts` and the exact save body of `tracking/store.ts`
 * (`signTrack` → atomic write → `writeLastNonce`) — kept sync on purpose here.
 */
import { readFileSync } from "node:fs";
import { projectStateDir } from "../runtime/project-state-dir";
import { harvestAgentEvidence } from "./evidence-harvest";
import { trackFile } from "../runtime/paths";
import { emptyTrack, type SessionTrack } from "../tracking/session-state";
import { signTrack, verifyTrack, writeLastNonce, type TrackEnvelope } from "../tracking/integrity";
import { atomicWrite } from "../util/json-io";
import { LOCK_FAILED, withTrackLockSync } from "../tracking/track-lock-sync";
import { trackJournalEnabled } from "../tracking/store";
import { appendEvent } from "../tracking/track-journal";
import { diffTrackEvents } from "../tracking/track-diff";
import { journalLogPath, readTrackSync } from "../tracking/track-compact";
import { dirname } from "node:path";

/** Load the current track synchronously; `emptyTrack()` when absent/corrupt (fail-closed read). */
function loadTrackSync(file: string): SessionTrack {
  try {
    return verifyTrack(JSON.parse(readFileSync(file, "utf8")) as TrackEnvelope) ?? emptyTrack();
  } catch {
    return emptyTrack();
  }
}

/**
 * Harvest the finishing sub-agent's transcript into its session track. Runs for
 * EVERY agent type (unlike the sniper reminder, which skips research/explore) —
 * those are exactly the agents whose research/explore evidence we want to credit.
 * Fully fail-open: a missing `agent_transcript_path`, an unreadable transcript, or
 * a write error leaves the track untouched and never throws out of the hook.
 * @param payload - The raw SubagentStop hook payload.
 * @param cwd - Project root (selects the per-project state dir).
 * @param now - Fallback epoch-ms for unstamped transcript tool_uses.
 * @param baseDir - Override the track base dir (tests); defaults to the project state dir.
 */
export function harvestSubagentTrack(payload: Record<string, unknown>, cwd: string, now: number, baseDir: string = projectStateDir(cwd)): void {
  const transcriptPath = typeof payload.agent_transcript_path === "string" ? payload.agent_transcript_path : undefined;
  if (!transcriptPath) return;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  updateTrackSync(trackFile(sessionId, baseDir), now, (track) => harvestAgentEvidence(transcriptPath, track, now));
}

/**
 * Read a track synchronously in the active storage mode (journal snapshot ⊕ log,
 * or the signed legacy file); `emptyTrack()` when absent/corrupt.
 * @param file - The session track file.
 */
export function readTrackAnySync(file: string): SessionTrack {
  return trackJournalEnabled() ? readTrackSync(file, true) : loadTrackSync(file);
}

/**
 * Synchronous fail-open track update for lifecycle hooks (cannot float async work).
 * `mutate` returning the SAME reference means "nothing to write".
 * @param file - The session track file.
 * @param now - Event timestamp for journal entries.
 * @param mutate - Pure transformation of the freshly read track.
 */
export function updateTrackSync(file: string, now: number, mutate: (track: SessionTrack) => SessionTrack): void {
  // Journal mode (default): snapshot ⊕ log read, then lock-free signed event
  // appends — same fail-open contract, never a "write skipped" under fan-out.
  if (trackJournalEnabled()) {
    const track = readTrackSync(file, true);
    const next = mutate(track);
    if (next === track) return; // nothing to add → no write
    const log = journalLogPath(file);
    for (const ev of diffTrackEvents(track, next, now)) appendEvent(log, ev.field, ev.op, ev.value, ev.ts);
    return;
  }
  // Locked RMW (legacy kill-switch path, sync variant — this path cannot float
  // async work): on contention the update is skipped like any other write
  // error, fail-open.
  const ran = withTrackLockSync(dirname(file), () => {
    const track = loadTrackSync(file);
    const next = mutate(track);
    if (next === track) return; // nothing to add (or unreadable) → no rewrite
    try {
      const envelope = signTrack(next);
      atomicWrite(file, JSON.stringify(envelope, null, 2));
      writeLastNonce(envelope.nonce);
    } catch { /* fail-open: a lifecycle hook must never throw */ }
  });
  if (ran === LOCK_FAILED) return;
}

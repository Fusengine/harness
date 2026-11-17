/**
 * @module store
 * Session-track persistence — TWO modes behind an env kill-switch:
 * - JOURNAL (default): writes append signed event lines to `track-<sid>.log`
 *   (short blocking lock, spill past the budget — see track-journal.ts), reads
 *   fold the log over the legacy `track-<sid>.json` snapshot. A write is never
 *   dropped for lock contention — compaction included (rename-atomic under the
 *   same fair lock, see track-compact.ts).
 * - LEGACY (`FUSE_TRACK_JOURNAL=0`): the original locked read-modify-write,
 *   kept fully intact below as the instant rollback (G1) — no redeploy needed.
 *   NOTE: =0 does NOT honour the uncompacted journal (the track reads as its
 *   last snapshot, possibly EMPTY); the events are recoverable by switching
 *   back to journal mode — never delete a `.log` during a =0 rollback.
 * The flag is read at CALL time so the switch is live.
 * @packageDocumentation
 */
import { readJsonFile, writeJsonFile } from "../util/json-io";
import { emptyTrack, type SessionTrack } from "./session-state";
import { signTrack, verifyTrack, writeLastNonce, type TrackEnvelope } from "./integrity";
import { LOCK_FAILED, withTrackLock } from "./track-lock";
import { dirname } from "node:path";
import { appendEvent } from "./track-journal";
import { diffTrackEvents } from "./track-diff";
import { journalLogPath, maybeCompactJournal, readTrackSync } from "./track-compact";
import { spillTrackDiff } from "./track-legacy-spill";

/** Journal mode is the default; `FUSE_TRACK_JOURNAL=0` reverts to the legacy locked RMW (see the module NOTE: =0 ignores the uncompacted journal — recoverable, keep the `.log`). */
export function trackJournalEnabled(): boolean {
  return process.env.FUSE_TRACK_JOURNAL !== "0";
}

/** Verified legacy snapshot (fail closed: absent/corrupt/tampered → emptyTrack). */
async function loadSnapshot(file: string): Promise<SessionTrack> {
  const envelope = await readJsonFile<TrackEnvelope>(file);
  if (!envelope) return emptyTrack();
  return verifyTrack(envelope) ?? emptyTrack();
}

/**
 * Load a session track: the verified legacy snapshot (the migration base — an
 * old `track-<sid>.json` with no log reads exactly as before) with the journal
 * folded on top. Fail closed on tampering (envelope MAC, per-line MAC).
 */
export async function loadTrack(file: string): Promise<SessionTrack> {
  if (!trackJournalEnabled()) return loadSnapshot(file);
  return readTrackSync(file, true); // chain-verified, read-only; a failure = empty track + `integrityFailure` (explicit reason on stderr)
}

/** Journal-mode write: append the mutation's events, then maybe compact. */
async function appendDiff(file: string, prev: SessionTrack, next: SessionTrack): Promise<boolean> {
  const log = journalLogPath(file);
  let ok = true;
  for (const ev of diffTrackEvents(prev, next, Date.now())) ok = appendEvent(log, ev.field, ev.op, ev.value, ev.ts) && ok;
  await maybeCompactJournal(file);
  return ok;
}

/**
 * Persist a session track. Journal mode appends the diff as signed events;
 * legacy mode signs and persists the tamper-evident envelope, then writes the
 * advisory nonce watermark.
 */
export async function saveTrack(file: string, track: SessionTrack): Promise<void> {
  if (trackJournalEnabled()) {
    await appendDiff(file, await loadTrack(file), track);
    return;
  }
  const envelope = signTrack(track);
  await writeJsonFile(file, envelope);
  writeLastNonce(envelope.nonce);
}

/**
 * Mutate a session track. Journal mode: load (snapshot ⊕ log), run `mutate`,
 * append the resulting events — lock-free, so a write is only ever lost to a
 * genuine I/O error (reported as `false`). Legacy mode: locked RMW that waits
 * the shared lock budget (fair, jittered); past it the write is SPILLED to the
 * journal (recoverable, stderr logged) and `false` is returned — never dropped,
 * never a crash.
 * @param file - The session track file.
 * @param mutate - Pure mutation over the freshly loaded track.
 * @returns True when the write landed.
 */
export async function withTrack(
  file: string,
  mutate: (track: SessionTrack) => SessionTrack | Promise<SessionTrack>,
): Promise<boolean> {
  if (trackJournalEnabled()) {
    const track = await loadTrack(file);
    return appendDiff(file, track, await mutate(track));
  }
  const ran = await withTrackLock(dirname(file), async () => {
    const track = await loadTrack(file);
    await saveTrack(file, await mutate(track));
  });
  if (ran !== LOCK_FAILED) return true;
  // The shared lock budget expired (`fn` never ran): never drop the write — spill its diff (journal mode folds it; `false` = not in the legacy snapshot).
  const prev = await loadTrack(file);
  spillTrackDiff(file, prev, await mutate(prev), Date.now()); // logs its own outcome on stderr
  return false;
}

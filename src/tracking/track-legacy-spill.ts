/**
 * @module track-legacy-spill
 * Last-resort persistence for the legacy (`FUSE_TRACK_JOURNAL=0`) locked RMW:
 * when the shared lock budget expires, the mutation is NOT dropped — its diff
 * is written as signed, lock-free spill files (track-spill.ts) beside the
 * journal log. Journal mode folds them (readers + compaction), so switching
 * the kill-switch back recovers every write; nothing is ever deleted here.
 * @packageDocumentation
 */
import { diffTrackEvents } from "./track-diff";
import { journalLogPath, sidOf } from "./track-chain";
import type { SessionTrack } from "./session-state";
import { signEvent } from "./track-journal";
import { spillEvent } from "./track-spill";

/**
 * Spill the `prev → next` mutation as unchained signed events.
 * @param file - The session track file.
 * @param prev - The track the mutation was computed from.
 * @param next - The mutated track.
 * @param now - Event timestamp (epoch ms).
 * @returns True when every event of the diff was spilled; false on an I/O or signing error (caller reports it).
 */
export function spillTrackDiff(file: string, prev: SessionTrack, next: SessionTrack, now: number): boolean {
  try {
    const log = journalLogPath(file), sid = sidOf(log);
    for (const ev of diffTrackEvents(prev, next, now)) {
      const signed = signEvent(ev.field, ev.op, ev.value, ev.ts, sid);
      if (!signed) throw new Error("event could not be signed");
      spillEvent(log, signed);
    }
    process.stderr.write(`harness: track lock busy past budget, write spilled to the journal (${log})\n`);
    return true;
  } catch (err) {
    process.stderr.write(`harness: track lock busy past budget, write NOT persisted, spill failed: ${String(err)} (${file})\n`);
    return false;
  }
}

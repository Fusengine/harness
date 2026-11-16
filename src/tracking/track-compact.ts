/**
 * @module track-compact
 * Read side + compaction for the track journal (see track-journal.ts):
 * - {@link parseEvents}/{@link readEvents}: MAC-verified replay — a tampered
 *   line is dropped, never the whole file (fail-closed PER LINE);
 * - {@link readTrackSync}: the sync snapshot ⊕ journal read for the sync gates;
 * - {@link maybeCompactJournal}: past {@link COMPACT_BYTES}, fold the log into
 *   the signed snapshot — RENAME-ATOMIC (logrotate pattern) under the EXISTING
 *   track lock (rare, skipped on contention). Lock-free appends stay SAFE in
 *   both race windows: before the rename → captured by the fold; after → a
 *   fresh log at the original path (appendFileSync keeps no fd across calls).
 * @packageDocumentation
 */
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "../util/json-io";
import { emptyTrack, type SessionTrack } from "./session-state";
import { readKey, signTrack, verifyEnvelope, verifyTrack, writeLastNonce, type TrackEnvelope } from "./integrity";
import { foldEvents, type TrackEvent } from "./track-journal";
import { GENESIS, journalLogPath, lineMacOk, parseLine, sealOf, sidOf, snapshotPathOf, type ChainPos } from "./track-chain";
import { readTrackReport, verifyJournal, walkChain } from "./track-verify";
import { withTrackLock } from "./track-lock";
import { captureSpills, dropFiles, listCapturedSpills, listSpills, releaseSpills } from "./track-spill";

export { journalLogPath } from "./track-chain";

/** Compact when the log exceeds this size (bytes). */
export const COMPACT_BYTES: number = 128 * 1024;

/** Folded-spill nonces remembered in the snapshot (recovery only needs the last compaction's). */
const FOLDED_SPILLS_CAP = 2048;

/** The verified events of a log (chain-checked, see track-verify) PLUS its pending spills; a failed verification → [] (the explicit reason: {@link verifyJournal}). The snapshot is taken from the log's `.json` twin. */
export function readEvents(logPath: string): TrackEvent[] {
  return verifyJournal(snapshotPathOf(logPath)).events;
}

/** Verified snapshot for the legacy (journal off) path: absent → empty; present but unverifiable (incl. no key — never created here) → empty (fail closed), sync. */
function readSnapshotSync(file: string): SessionTrack {
  try {
    return verifyTrack(JSON.parse(readFileSync(file, "utf8")) as TrackEnvelope) ?? emptyTrack();
  } catch {
    return emptyTrack();
  }
}

/** Sync snapshot ⊕ journal read for the sync gates; `journal=false` = legacy kill-switch path. A journal that fails verification reads as an EMPTY track carrying `integrityFailure` (never as the stale/rolled-back snapshot). */
export function readTrackSync(file: string, journal: boolean): SessionTrack {
  return journal ? readTrackReport(file).track : readSnapshotSync(file);
}

/** Strict snapshot read for the fold: absent → empty; unverifiable → throw (never overwrite a tampered snapshot with a laundered fold). */
function readSnapshotStrict(file: string, key: string, sid: string): { track: SessionTrack; mac?: string } {
  if (!existsSync(file)) return { track: emptyTrack() };
  const env = JSON.parse(readFileSync(file, "utf8")) as TrackEnvelope;
  const t = verifyEnvelope(env, key);
  if (!t) throw new Error("fuse: snapshot MAC mismatch, fold aborted");
  if (t.chainHead && t.chainHead.sid !== sid) throw new Error("fuse: snapshot bound to another session, fold aborted");
  return { track: t, mac: t.chainHead ? undefined : env.mac }; // a legacy snapshot's MAC is part of the seal
}

/** Fold captured files (`.folding` log and/or captured spills) into the signed snapshot (signTrack + nonce, unchanged), carrying the chain head forward. The captured log is chain-verified FIRST: a break aborts the fold (nothing is laundered — the tampered state stays on disk and keeps failing). Raw read, no spill discovery. */
function foldIntoSnapshot(file: string, captured: string[]): void {
  const key = readKey();
  if (key === null) throw new Error("fuse: no key, fold aborted");
  const sid = sidOf(journalLogPath(file)), { track: base, mac: snapMac } = readSnapshotStrict(file, key, sid);
  const start: ChainPos = base.chainHead ?? { seq: 0, mac: GENESIS };
  const done = new Set(base.foldedSpills ?? []);
  const isSpill = (p: string): boolean => p.includes(".spill."); // the `.folding` LOG capture has no `.spill.` in its name
  const spillTexts = captured.filter(isSpill).map((p) => readFileSync(p, "utf8"));
  const walk = walkChain(captured.filter((p) => !isSpill(p)).map((p) => readFileSync(p, "utf8")), key, sid, start, spillTexts, snapMac); // seq <= start.seq (crashed-compaction re-fold) are skipped
  if (walk.failure) throw new Error(`fuse: chain ${walk.failure.reason}, fold aborted`);
  const seen = new Set<string>(walk.events.map((e) => e.nonce)), events: TrackEvent[] = [...walk.events], spillNonces: string[] = [];
  const sealed = start.mac !== GENESIS; // a session-unbound v1 spill line is only trusted while unsealed (or matched into the seal digest by the walk above)
  for (const text of spillTexts) {
    for (const line of text.split("\n")) {
      const e = line ? parseLine(line) : null;
      if (!e || seen.has(e.nonce) || done.has(e.nonce) || !lineMacOk(key, e) || (e.v === 1 && sealed) || (e.v === 2 && (e.sid !== sid || e.seq !== undefined))) continue; // idempotent re-fold
      seen.add(e.nonce); events.push(e); spillNonces.push(e.nonce);
    }
  }
  const folded = foldEvents(events, base);
  // chain head after the fold: the last chained line, else — an unchained prefix only — its seal (the SAME digest a chained line appended before this fold expects, see chainTip), else unchanged
  const absorbedV1 = events.filter((e) => e.v === 1 && spillNonces.includes(e.nonce)).map((e) => e.mac);
  // (every snapshot THIS code writes carries a head, so it is never mistaken for a legacy snapshot — whose MAC would then enter the seal)
  const head: ChainPos = walk.tip.seq > start.seq ? walk.tip : start.mac === GENESIS ? { seq: 0, mac: sealOf(snapMac, walk.legacyMacs, absorbedV1) } : start;
  folded.chainHead = { ...head, sid };
  // same atomic write as the events; the cap never truncates below one whole fold
  if (spillNonces.length) folded.foldedSpills = [...(base.foldedSpills ?? []), ...spillNonces].slice(-Math.max(FOLDED_SPILLS_CAP, spillNonces.length));
  const envelope = signTrack(folded);
  atomicWrite(file, JSON.stringify(envelope, null, 2));
  writeLastNonce(envelope.nonce);
}

/** Rename-atomic compaction: rename captures the WHOLE log (and every pending spill), fold, unlink. A crash leaves `.folding` captures (recovered first next run); on fold failure BEFORE commit they are renamed back — never a lost event, and never an event in BOTH snapshot and log (no double-count). Spills are deleted only AFTER the snapshot is durably written. */
function compactSync(file: string): void {
  const log = journalLogPath(file), folding = `${log}.folding`;
  const left = [...(existsSync(folding) ? [folding] : []), ...listCapturedSpills(log)];
  if (left.length) { foldIntoSnapshot(file, left); dropFiles(left); } // crashed compaction recovery
  const hasLog = existsSync(log);
  if (hasLog) renameSync(log, folding); // atomic capture; the next append recreates a fresh log
  const spills = captureSpills(log);
  const captured = [...(hasLog ? [folding] : []), ...spills];
  if (!captured.length) return;
  let committed = false;
  try {
    foldIntoSnapshot(file, captured);
    committed = true; // the snapshot now HOLDS the events: never return them to the log
    dropFiles(captured);
  } catch (err) {
    if (!committed) { if (hasLog) { try { renameSync(folding, log); } catch { /* keep .folding for recovery */ } } releaseSpills(spills); }
    else dropFiles(captured); // residue iff unlink itself failed
    throw err;
  }
}

/** Trigger compaction past the cap (`FUSE_TRACK_COMPACT_BYTES` overrides {@link COMPACT_BYTES}), under the existing lock (skipped on contention). */
export async function maybeCompactJournal(file: string): Promise<void> {
  const cap = Number(process.env.FUSE_TRACK_COMPACT_BYTES) || COMPACT_BYTES;
  let size = -1; // no log yet
  try { size = statSync(journalLogPath(file)).size; } catch { /* spills may still be pending */ }
  const lp = journalLogPath(file);
  // pending spills or crashed-compaction captures always trigger an absorb/recovery
  if (size < cap && !listSpills(lp).length && !listCapturedSpills(lp).length && !existsSync(`${lp}.folding`)) return;
  await withTrackLock(dirname(file), async () => {
    try { compactSync(file); } catch { /* rare path: the next trigger retries */ }
  });
}

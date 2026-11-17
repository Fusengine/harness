/**
 * @module track-verify
 * Read-only, fail-closed verification of a track journal (snapshot + log +
 * head + spills). NEVER writes and NEVER creates the key: on a fresh HOME a
 * track that exists on disk but has no key is an explicit failure, never an
 * empty valid track. Any chain gap/break returns an explicit {@link FailReason};
 * the track view of a failed journal is EMPTY (see {@link readTrackReport}) —
 * a rolled-back snapshot must not keep an old passing receipt alive.
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import { readKey, verifyEnvelope, type TrackEnvelope } from "./integrity";
import { emptyTrack, type SessionTrack } from "./session-state";
import { GENESIS, headPath, journalLogPath, lineMacOk, parseLine, readHead, sealOf, sidOf, snapshotPathOf, v1Macs, type ChainPos } from "./track-chain";
import { foldEvents, type TrackEvent } from "./track-journal";
import { listSpills, readSpillTexts } from "./track-spill";

/** Why a journal failed verification. */
export type FailReason =
  | "key-missing" | "missing" | "snapshot-invalid" | "bad-mac" | "foreign-session" | "unchained-in-log"
  | "gap" | "duplicate-or-reorder" | "broken-chain" | "tampered-line" | "legacy-after-chain"
  | "head-missing" | "head-invalid" | "head-mismatch" | "truncated";

/** Verification verdict (explicit failure reason, never silent). */
export interface IntegrityReport { ok: boolean; reason?: FailReason; detail?: string; /** true when legacy (unchained) state was accepted read-only */ legacy: boolean; /** true when nothing exists on disk for this track (normal first use) */ empty: boolean }
/** Verified view: the snapshot base and the verified events to fold over it. */
export interface JournalView { report: IntegrityReport; base: SessionTrack; events: TrackEvent[] }
/** Outcome of {@link walkChain}. */
export interface ChainWalk { events: TrackEvent[]; tip: ChainPos; legacyMacs: string[]; invalid: number; failure?: { reason: FailReason; detail: string } }

/** Walk journal `texts` (oldest first) from chain position `start`: verify every line's MAC/session/sequence/link; stop at the first break. Lines at or below `start.seq` (already folded) are skipped. */
export function walkChain(texts: string[], key: string, sid: string, start: ChainPos, spillTexts: string[] = [], snapMac?: string): ChainWalk {
  const events: TrackEvent[] = [], legacyMacs: string[] = [], seen = new Set<string>();
  let exp = start.seq + 1, prev = start.mac, tip = start, invalid = 0, sealed = start.mac !== GENESIS, failure: ChainWalk["failure"];
  const fail = (reason: FailReason, detail: string): void => { failure = { reason, detail }; };
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line || failure) continue;
      const ev = parseLine(line);
      if (!ev) { invalid++; continue; } // junk (crash residue / corruption): treated as absent — a lost chained line shows as a gap
      if (!lineMacOk(key, ev)) { fail("bad-mac", `forged or edited line (nonce ${ev.nonce})`); continue; }
      if (ev.v === 1) {
        if (sealed) fail("legacy-after-chain", "unchained v1 line after the chain started");
        else if (!seen.has(ev.nonce)) { seen.add(ev.nonce); legacyMacs.push(ev.mac); events.push(ev); }
        continue;
      }
      if (ev.sid !== sid) { fail("foreign-session", `line bound to session ${ev.sid}`); continue; }
      if (ev.seq === undefined) { fail("unchained-in-log", "spill-form line inside the chained log"); continue; }
      if (ev.seq <= start.seq) continue; // already folded into the snapshot
      if (!sealed) prev = sealOf(snapMac, legacyMacs, v1Macs(spillTexts, key, new Set(seen))); // the first chained line seals the unchained prefix: legacy snapshot + log lines + the v1 spills pending at that moment
      if (ev.seq !== exp) fail(invalid > 0 ? "tampered-line" : ev.seq < exp ? "duplicate-or-reorder" : "gap", `expected seq ${exp}, got ${ev.seq}`);
      else if (ev.prev !== prev) fail("broken-chain", `seq ${ev.seq} does not continue the previous line`);
      else { events.push(ev); exp++; prev = ev.mac; tip = { seq: ev.seq, mac: ev.mac }; sealed = true; }
    }
  }
  return { events, tip, legacyMacs, invalid, failure };
}

const bad = (reason: FailReason, detail: string, legacy = false): JournalView => ({ report: { ok: false, reason, detail, legacy, empty: false }, base: emptyTrack(), events: [] });

function verifyOnce(file: string): JournalView {
  const log = journalLogPath(file), folding = `${log}.folding`, snap = snapshotPathOf(log), sid = sidOf(log);
  const present = [log, folding, snap, headPath(log)].filter((p) => existsSync(p));
  if (!present.length && !listSpills(log).length) return { report: { ok: true, legacy: false, empty: true }, base: emptyTrack(), events: [] };
  const key = readKey(); // NEVER create: a missing key on existing state is a failure
  if (key === null) return bad("key-missing", "track state exists but there is no key");
  let base = emptyTrack(), snapMac: string | undefined;
  if (existsSync(snap)) {
    let t: SessionTrack | null = null, env: TrackEnvelope | null = null;
    try { env = JSON.parse(readFileSync(snap, "utf8")) as TrackEnvelope; t = verifyEnvelope(env, key); } catch { /* invalid */ }
    if (!t || !env) return bad("snapshot-invalid", "snapshot unreadable or MAC mismatch");
    if (t.chainHead && t.chainHead.sid !== sid) return bad("foreign-session", `snapshot chain head bound to session ${t.chainHead.sid}`); // a snapshot copied from another session
    base = t;
    if (!t.chainHead) snapMac = env.mac; // a legacy snapshot is part of the seal
  }
  const texts = [folding, log].filter((p) => existsSync(p)).map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } });
  const start: ChainPos = base.chainHead ?? { seq: 0, mac: GENESIS };
  const spillTexts = readSpillTexts(log);
  const w = walkChain(texts, key, sid, start, spillTexts, snapMac);
  if (w.failure) return bad(w.failure.reason, w.failure.detail);
  const head = readHead(log, key);
  if (head === "invalid") return bad("head-invalid", "head file forged or unreadable");
  if (head === null && w.tip.seq > 0) return bad("head-missing", "chain exists but its head file is gone");
  if (head) {
    const at = w.events.find((e) => e.seq === head.seq)?.mac ?? (head.seq === start.seq ? start.mac : undefined);
    if (w.tip.seq < head.seq) return bad(!present.some((p) => p !== headPath(log)) ? "missing" : w.invalid ? "tampered-line" : "truncated", `log ends at seq ${w.tip.seq}, head says ${head.seq}`);
    if ((w.tip.seq === head.seq && w.tip.mac !== head.mac) || (at !== undefined && at !== head.mac)) return bad("head-mismatch", `line at seq ${head.seq} does not match the head`);
  }
  const events = [...w.events];
  const seen = new Set(events.map((e) => e.nonce));
  const sealed = start.mac !== GENESIS; // a v1 spill is only trusted while unsealed, or when the walk matched it into the seal digest (a v1 spill added after sealing changed the digest: broken-chain above)
  for (const text of spillTexts) { // lock-free overflow: sid-bound, unchained; a bad spill line is skipped (never trusted)
    for (const line of text.split("\n")) {
      const ev = line ? parseLine(line) : null;
      if (!ev || seen.has(ev.nonce) || !lineMacOk(key, ev) || (ev.v === 1 && sealed) || (ev.v === 2 && (ev.sid !== sid || ev.seq !== undefined))) continue;
      seen.add(ev.nonce); events.push(ev);
    }
  }
  return { report: { ok: true, legacy: events.some((e) => e.v === 1) || (existsSync(snap) && !base.chainHead), empty: false }, base, events };
}

/** Failure reasons a reader racing a compaction/append can see transiently (half-moved state); every other reason is deterministic tampering and is believed at once. */
const TRANSIENT: ReadonlySet<FailReason> = new Set<FailReason>(["gap", "duplicate-or-reorder", "tampered-line", "truncated", "missing", "head-mismatch", "head-missing", "snapshot-invalid", "broken-chain"]);

/** Verify a track (snapshot + log + head + spills) without writing anything. A transient-capable failure is re-read up to 3 times (5/10/20 ms) before it is believed; real tampering persists. */
export function verifyJournal(file: string): JournalView {
  let v = verifyOnce(file);
  for (let wait = 5; wait <= 20 && !v.report.ok && TRANSIENT.has(v.report.reason!); wait *= 2) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    v = verifyOnce(file);
  }
  return v;
}

const warned = new Set<string>();

/** Snapshot ⊕ verified journal as a {@link SessionTrack}. On verification failure the track is EMPTY with `integrityFailure` set (fail closed) and the reason is written once to stderr. */
export function readTrackReport(file: string): { track: SessionTrack; report: IntegrityReport } {
  const { report, base, events } = verifyJournal(file);
  if (!report.ok) {
    const k = `${file}:${report.reason}`;
    if (!warned.has(k)) { warned.add(k); process.stderr.write(`harness: track integrity failure (${report.reason}: ${report.detail}) ${file}\n`); }
    return { track: { ...emptyTrack(), integrityFailure: report.reason }, report };
  }
  const { chainHead: _chain, ...track } = foldEvents(events, base); // chain bookkeeping stays internal: the track a gate sees is identical to a pre-chain one
  return { track, report };
}

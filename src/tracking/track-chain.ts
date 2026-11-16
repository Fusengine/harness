/**
 * @module track-chain
 * Hash-chain primitives for the signed track journal. Every chained line's MAC
 * covers `{k, sid, seq, prev, field, op, value, ts}` (+ its nonce): the session
 * id (a line replayed into another session fails), a monotonic sequence number
 * and the previous line's MAC (reorder / duplicate / deletion break the link).
 * A MAC-protected sidecar `.head` file records the last appended `{seq, mac}`
 * so a truncation / rollback of the log (or deletion of its last line) is
 * detected. Lock-free spill lines carry no `seq` (kind `s`): sid-bound only.
 * Legacy (`v:1`) lines keep their historical MAC and are verified read-only.
 * @packageDocumentation
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { computeMac, verifyEnvelope, type TrackEnvelope } from "./integrity";
import { readSpillTexts } from "./track-spill";
import type { TrackEvent } from "./track-journal";

/** Chain position before any chained line exists. */
export const GENESIS: string = "0".repeat(64);
/** Hard cap per line — short lines stay non-interleaved under O_APPEND. */
export const MAX_LINE: number = 32 * 1024;
/** A chain position: sequence number + that line's MAC. */
export type ChainPos = { seq: number; mac: string };

/** Session id a journal belongs to: its file name without the `.log` suffix. */
export const sidOf: (logPath: string) => string = (logPath) => basename(logPath).replace(/\.log$/, "");
/** Sidecar head file of a journal. */
export const headPath: (logPath: string) => string = (logPath) => logPath.replace(/\.log$/, ".head");
/** Digest sealing a legacy (unchained) prefix into the first chained line's `prev`. */
export const legacyDigest: (macs: string[]) => string = (macs) => createHash("sha256").update(macs.join("\n")).digest("hex");

const dataOf = (e: { sid?: string; seq?: number; prev?: string; field: string; op: string; value: unknown; ts: number }): string =>
  JSON.stringify({ k: e.seq === undefined ? "s" : "c", sid: e.sid, seq: e.seq, prev: e.prev, field: e.field, op: e.op, value: e.value, ts: e.ts });

/** Sign one v2 event (chained when `pos` is given, else an unchained spill line). An oversized STRING value is truncated then signed; an oversized non-string → null. */
export function buildEvent(key: string, sid: string, field: string, op: TrackEvent["op"], value: unknown, ts: number, pos?: ChainPos): TrackEvent | null {
  const mk = (v: unknown) => ({ sid, seq: pos ? pos.seq + 1 : undefined, prev: pos?.mac, field, op, value: v, ts });
  let body = mk(value), data = dataOf(body);
  if (data.length > MAX_LINE - 256) {
    if (typeof value !== "string") return null;
    body = mk(value.slice(0, Math.max(0, value.length - (data.length - (MAX_LINE - 256)))));
    data = dataOf(body);
  }
  const nonce = randomBytes(8).toString("hex");
  return { v: 2, ...body, nonce, mac: computeMac(key, data, nonce) };
}

/** Verify a v2 line's MAC; v1 lines use the historical (unbound) MAC. */
export function lineMacOk(key: string, ev: TrackEvent): boolean {
  const data = ev.v === 2 ? dataOf(ev) : JSON.stringify({ field: ev.field, op: ev.op, value: ev.value, ts: ev.ts });
  return ev.mac === computeMac(key, data, ev.nonce);
}

/** Parse one raw journal line into a structurally valid event, or null. */
export function parseLine(line: string): TrackEvent | null {
  try {
    const ev = JSON.parse(line) as TrackEvent;
    if ((ev?.v !== 1 && ev?.v !== 2) || typeof ev.nonce !== "string" || typeof ev.ts !== "number" || typeof ev.mac !== "string") return null;
    if (ev.v === 2 && (typeof ev.sid !== "string" || (ev.seq !== undefined && (!Number.isInteger(ev.seq) || typeof ev.prev !== "string")))) return null;
    return ev;
  } catch { return null; }
}

/** The head file: `{seq, mac}` of the last appended chained line, MAC-bound to the session. `null` = absent, `"invalid"` = present but unreadable/forged. */
export function readHead(logPath: string, key: string): ChainPos | "invalid" | null {
  let raw: string;
  try { raw = readFileSync(headPath(logPath), "utf8"); } catch { return null; }
  try {
    const h = JSON.parse(raw) as { seq: number; mac: string; hm: string };
    return Number.isInteger(h.seq) && h.hm === computeMac(key, `${sidOf(logPath)}:${h.seq}:${h.mac}`, "head") ? { seq: h.seq, mac: h.mac } : "invalid";
  } catch { return "invalid"; }
}

/** Persist the head (tmp + atomic rename) — call under the track lock. */
export function writeHead(logPath: string, key: string, pos: ChainPos): void {
  const dest = headPath(logPath), tmp = `${dest}.tmp`; // fixed tmp name: the track lock serialises every writer
  writeFileSync(tmp, JSON.stringify({ ...pos, hm: computeMac(key, `${sidOf(logPath)}:${pos.seq}:${pos.mac}`, "head") }), { mode: 0o600 });
  renameSync(tmp, dest);
}

/** Read the last `bytes` of a file (whole file when smaller) plus its size; null when absent. */
function tailOf(path: string, bytes: number): { text: string; size: number; whole: boolean } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString("utf8"), size, whole: len === size };
  } finally { closeSync(fd); }
}

/** Does the file end in a newline (or is it empty)? A crash-truncated last line must not swallow the next append. */
export function endsClean(logPath: string): boolean {
  const t = tailOf(logPath, 1);
  return !t || t.size === 0 || t.text === "\n";
}

/** The journal log path twin of a track snapshot path. */
export function journalLogPath(trackPath: string): string {
  return trackPath.replace(/\.json$/, ".log");
}

/** What the chain needs from the verified snapshot: its session-bound chain head (absent on a legacy snapshot) and its envelope MAC (the identity a legacy snapshot is sealed by). */
export type SnapInfo = { head?: ChainPos & { sid?: string }; mac: string };

/** The seal digest of an unchained prefix: the legacy snapshot's MAC, the legacy log lines (`.folding` capture first), then the v1 spills pending at sealing — one per nonce. The first chained line's `prev`; a verifier recomputes it, so planting/replacing/adding any of them afterwards breaks the link. Empty prefix = {@link GENESIS}. */
export function sealOf(snapMac: string | undefined, logMacs: string[], spillMacs: string[]): string {
  const all = [...(snapMac ? [snapMac] : []), ...logMacs, ...spillMacs];
  return all.length ? legacyDigest(all) : GENESIS;
}

/** The chain position a NEW line must continue from (call under the track lock): the last chained line of the log, else the head / snapshot head, else the seal of the legacy prefix (snapshot + `.folding` + log + v1 spills), else genesis. */
export function chainTip(logPath: string, key: string, snapshot: () => SnapInfo | undefined): ChainPos {
  const lastChained = (text: string): ChainPos | null => {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = lines[i] ? parseLine(lines[i]!) : null;
      if (ev?.v === 2 && ev.seq !== undefined && ev.sid === sidOf(logPath)) return { seq: ev.seq, mac: ev.mac };
    }
    return null;
  };
  let all: { text: string; size: number; whole: boolean } | null = null;
  for (const bytes of [4 * 1024, 64 * 1024, Infinity]) { // the last line is almost always in the first 4 KB; widen only when it is not
    all = tailOf(logPath, bytes);
    const found = all ? lastChained(all.text) : null;
    if (found) return found;
    if (!all || all.whole) break;
  }
  const head = readHead(logPath, key);
  const h = head && head !== "invalid" ? head : null;
  const snap = snapshot(), sh = snap?.head;
  if (h && (!sh || h.seq >= sh.seq)) return h;
  if (sh) return sh;
  // no chain yet: seal the unchained prefix EXACTLY as the verifier's walk counts it
  const seen = new Set<string>();
  const whole = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const logMacs = v1Macs([whole(`${logPath}.folding`), whole(logPath)], key, seen);
  return { seq: 0, mac: sealOf(snap?.mac, logMacs, v1Macs(readSpillTexts(logPath), key, seen)) };
}

/** MACs of the valid v1 (legacy) lines in `texts`, one per nonce (first seen wins), skipping nonces already in `seen` (which is extended). */
export function v1Macs(texts: string[], key: string, seen: Set<string>): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const l of t.split("\n")) {
      const e = l ? parseLine(l) : null;
      if (e?.v === 1 && !seen.has(e.nonce) && lineMacOk(key, e)) { seen.add(e.nonce); out.push(e.mac); }
    }
  }
  return out;
}

/** Snapshot file twin of a journal. */
export const snapshotPathOf = (logPath: string): string => logPath.replace(/\.log$/, ".json");

/** The verified snapshot's {@link SnapInfo} (undefined when absent or invalid). */
export function snapshotInfoOf(logPath: string, key: string): SnapInfo | undefined {
  try {
    const env = JSON.parse(readFileSync(snapshotPathOf(logPath), "utf8")) as TrackEnvelope;
    const t = verifyEnvelope(env, key);
    return t ? { head: t.chainHead, mac: env.mac } : undefined;
  } catch { return undefined; }
}

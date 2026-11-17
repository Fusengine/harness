/**
 * @module track-journal
 * Append-only, per-line-signed event journal for {@link SessionTrack} — the
 * fan-out-immune replacement for the locked RMW (generalises the freshness/
 * ref-journal.ts pattern to every field). Appends serialise on a SHORT
 * BLOCKING track lock (never skipped, sub-ms wait — see appendEvent) so they
 * can never race the rename-atomic compaction: zero lost write. Per-line HMAC
 * (same key/scheme as integrity.ts): a tampered line is dropped, never the
 * whole file (fail-closed PER LINE).
 * @packageDocumentation
 */
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadOrCreateKey } from "./integrity";
import { buildEvent, chainTip, endsClean, sidOf, snapshotInfoOf, writeHead } from "./track-chain";
import { LOCK_FAILED, withTrackLockSyncBlocking } from "./track-lock-sync";
import { spillEvent } from "./track-spill";
import { emptyTrack, PRD_VIOLATIONS_CAP, type PrdViolationRecord, type SessionTrack } from "./session-state";
import type { AuthEntry } from "../freshness/doc-helpers";
import type { SessionTarget } from "../policy/apex-authorization";
import type { Receipt } from "./receipts";

/**
 * One journal line. v2 (current): `mac` covers `{k, sid, seq, prev, field, op, value, ts}` + nonce — `seq`/`prev` present = chained main-log line, absent = lock-free spill line (sid-bound only). v1 (legacy, read-only): `mac` over `{field, op, value, ts}` + nonce, no session/position binding.
 */
export type TrackEvent = { v: 1 | 2; field: string; op: "add" | "max" | "append" | "merge" | "set"; value: unknown; ts: number; nonce: string; mac: string; sid?: string; seq?: number; prev?: string };

/** Trivial-edit sliding window for the fold (mirrors gate.ts DEFAULT_WINDOW_MS). */
const TRIVIAL_WINDOW_MS = 120_000;

/** Sign one UNCHAINED (spill-form) event bound to session `sid`: an oversized STRING value is truncated then re-signed (never an unsigned partial line); an oversized non-string is dropped (null). */
export function signEvent(field: string, op: TrackEvent["op"], value: unknown, ts: number, sid = ""): TrackEvent | null {
  return buildEvent(loadOrCreateKey(), sid, field, op, value, ts);
}

/**
 * Append one signed, CHAINED event (session id + monotonic seq + previous
 * line's MAC, see track-chain) under the BOUNDED blocking track lock (same
 * `track.lock` as the compaction — an append can never straddle
 * rename/fold/unlink; the lock also serialises seq assignment). The key is
 * created HERE (write path) and nowhere on read. If the lock stays busy past
 * the budget (`FUSE_TRACK_LOCK_BUDGET_MS`), the event is SPILLED unchained to
 * its own lock-free file ({@link spillEvent}) that every reader folds and the
 * compactor absorbs — the hook never waits unboundedly and the event is never
 * lost. Fail-open (`false`) only on a genuine I/O error.
 */
export function appendEvent(logPath: string, field: string, op: TrackEvent["op"], value: unknown, ts: number): boolean {
  try {
    const key = loadOrCreateKey(), sid = sidOf(logPath);
    const r = withTrackLockSyncBlocking(dirname(logPath), () => {
      const ev = buildEvent(key, sid, field, op, value, ts, chainTip(logPath, key, () => snapshotInfoOf(logPath, key)));
      if (!ev) return false;
      appendFileSync(logPath, (endsClean(logPath) ? "" : "\n") + JSON.stringify(ev) + "\n", "utf8");
      writeHead(logPath, key, { seq: ev.seq!, mac: ev.mac });
      return true;
    });
    if (r === LOCK_FAILED) {
      process.stderr.write(`harness: track lock busy past budget, event spilled (${logPath})\n`);
      const ev = buildEvent(key, sid, field, op, value, ts);
      if (!ev) return false;
      spillEvent(logPath, ev);
      return true;
    }
    return r;
  } catch { return false; }
}

const union = (a?: string[], b?: string[]): string[] => [...new Set([...(a ?? []), ...(b ?? [])])];

/** Merge one auth entry: non-empty list fields union, scalars of the later-folded (newer) event win. */
function mergeAuth(p: AuthEntry | undefined, e: AuthEntry): AuthEntry {
  const b = p ?? {}, out: AuthEntry = { ...b, ...e };
  const sessions = union(b.sessions, e.sessions);
  if (sessions.length) out.sessions = sessions;
  const docSessions = union(b.doc_sessions, e.doc_sessions);
  if (docSessions.length) out.doc_sessions = docSessions;
  const sources = union(b.sources ?? (b.source ? [b.source] : []), e.sources ?? (e.source ? [e.source] : []));
  if (sources.length) out.sources = sources;
  const readPaths = union(b.read_paths, e.read_paths);
  if (readPaths.length) out.read_paths = readPaths;
  return out;
}

/**
 * Replay events over `base` (the legacy snapshot — emptyTrack when absent).
 * Deterministic CRDT fold with a STABLE sort on ts (log order breaks ties):
 * refsRead = dedup union; refsReadAt = per-key max; agents/receipts =
 * ts-ordered append, never deduped; authorizations = per-key merge (list
 * unions); trivialEdits = union re-filtered by the sliding window;
 * target/brainstormRequired = last-writer-wins on ts.
 */
export function foldEvents(events: TrackEvent[], base: SessionTrack = emptyTrack()): SessionTrack {
  const t: SessionTrack = { ...base, refsRead: [...base.refsRead], agents: [...base.agents], authorizations: { ...base.authorizations }, trivialEdits: [] };
  const at: Record<string, number> = { ...base.refsReadAt };
  const receipts: Receipt[] = [...(base.receipts ?? [])];
  const trivial = new Set(base.trivialEdits ?? []);
  const prdOwners: Record<string, string> = { ...base.prdOwners };
  const prdViolations: PrdViolationRecord[] = [...(base.prdViolations ?? [])];
  const prdStopBlocked: Record<string, number> = { ...base.prdStopBlocked };
  let targetTs = base.target ? Date.parse(base.target.set_at) || 0 : 0, brainstormTs = 0; // a base flag is unstamped: any event overrides it
  for (const ev of [...events].sort((a, b) => a.ts - b.ts)) { // stable: log order breaks ts ties
    if (ev.field === "refsRead") { const p = String(ev.value); if (!t.refsRead.includes(p)) t.refsRead.push(p); }
    else if (ev.field === "refsReadAt") { const [p, ts] = ev.value as [string, number]; if ((at[p] ?? -1) < ts) at[p] = ts; }
    else if (ev.field === "agents") t.agents.push(ev.value as SessionTrack["agents"][number]);
    else if (ev.field === "receipts") receipts.push(ev.value as Receipt);
    else if (ev.field === "authorizations") { const m = ev.value as { key: string; entry: AuthEntry }; t.authorizations[m.key] = mergeAuth(t.authorizations[m.key], m.entry); }
    else if (ev.field === "trivialEdits") trivial.add(Number(ev.value));
    else if (ev.field === "target" && ev.ts >= targetTs) { t.target = ev.value as SessionTarget; targetTs = ev.ts; }
    else if (ev.field === "brainstormRequired" && ev.ts >= brainstormTs) { t.brainstormRequired = Boolean(ev.value); brainstormTs = ev.ts; }
    else if (ev.field === "prdOwners") { const [aid, name] = ev.value as [string, string]; prdOwners[aid] = name; }
    else if (ev.field === "prdViolations") { prdViolations.push(ev.value as PrdViolationRecord); }
    else if (ev.field === "prdStopBlocked") { const [key, ts] = ev.value as [string, number]; prdStopBlocked[key] = ts; }
  }
  if (Object.keys(at).length) t.refsReadAt = at;
  if (receipts.length) t.receipts = receipts;
  if (Object.keys(prdOwners).length) t.prdOwners = prdOwners;
  if (prdViolations.length) t.prdViolations = prdViolations.slice(-PRD_VIOLATIONS_CAP);
  if (Object.keys(prdStopBlocked).length) t.prdStopBlocked = prdStopBlocked;
  const maxT = Math.max(0, ...trivial);
  t.trivialEdits = [...trivial].filter((x) => x > maxT - TRIVIAL_WINDOW_MS).sort((a, b) => a - b);
  return t;
}

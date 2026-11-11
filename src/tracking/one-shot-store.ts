/**
 * @module one-shot-store
 * Pure, IO-free state model for the per-gate one-shot metric ({@link module:one-shot}).
 *
 * Measures the owner's "precision / one-shot" criterion: per gate (keyed by the
 * block prompt's title) how many times it DENIED and how many were later cleared
 * by a fix: an allow of the same operation, or — for a denied Bash write — a
 * Write/Edit on the file the command targeted (different op key by construction).
 * Globally: `firstTry` (a gateable op that passed with NO prior deny = one-shot)
 * vs `corrected` (passed after a deny; one per allow, even if it clears 2 denies).
 * Every deny/fix/abandon is also logged ({@link module:one-shot-events}).
 * @packageDocumentation
 */
import { expirePending, sharesTarget, withEvent } from "./one-shot-events";
import { EMPTY, type GateStat, type OneShotState, type OutcomeMeta, type Pending } from "./one-shot-types";

export { EMPTY } from "./one-shot-types";
export type { GateStat, OneShotEvent, OneShotOutcome, OneShotState, OutcomeMeta, Pending } from "./one-shot-types";
export { formatSummary } from "./one-shot-summary";

/**
 * Drop stale data: whole-state idle reset past the window, else per-entry prune of
 * gates/events by `windowMs`; a pending deny older than `abandonMs` (default =
 * `windowMs`) is removed AND logged as `abandoned`. Keeps the "7d" window honest.
 */
export function pruneState(s: OneShotState, now: number, windowMs: number, abandonMs: number = windowMs): OneShotState {
  if (now - s.updatedAt >= windowMs) return { ...EMPTY };
  const gates: Record<string, GateStat> = {};
  for (const [k, g] of Object.entries(s.gates)) if (now - g.lastTs < windowMs) gates[k] = g;
  return { ...s, gates, ...expirePending(s, now, abandonMs, windowMs) };
}

/**
 * Record a deny for gate `title` on operation `op` (content-free tool identity):
 * bump the gate's deny count, mark `op` pending (with the denied file `targets`),
 * log `denied` — or `denied-again` when `op`, or a target of it, is already pending.
 */
export function applyDeny(s: OneShotState, title: string, op: string, now: number, meta: OutcomeMeta = {}): OneShotState {
  const g = s.gates[title] ?? { denies: 0, corrected: 0, lastTs: 0 };
  const again = op in s.pending || Object.values(s.pending).some((p) => (!p.sid || !meta.sid || p.sid === meta.sid) && sharesTarget(p.targets, meta.targets));
  const next: OneShotState = {
    ...s,
    gates: { ...s.gates, [title]: { denies: g.denies + 1, corrected: g.corrected, lastTs: now } },
    pending: { ...s.pending, [op]: { title, ts: now, ...(meta.targets?.length ? { targets: meta.targets } : {}), ...(meta.sid ? { sid: meta.sid } : {}) } },
    updatedAt: now,
  };
  return withEvent(next, { ts: now, sid: meta.sid, gate: title, op, target: meta.targets?.[0], outcome: again ? "denied-again" : "denied" });
}

/**
 * Record an allow for a gateable `op`. A non-gateable allow (Read/Task/MCP) leaves
 * state untouched. Otherwise every pending deny cleared by it — the same `op`, or a
 * Bash-write deny whose targets include `meta.target` — is `corrected` (credited to
 * ITS gate, logged); none pending → `firstTry` (one-shot). Global `corrected` +1.
 */
export function applyAllow(s: OneShotState, op: string, now: number, gateable: boolean, meta: OutcomeMeta = {}): OneShotState {
  if (!gateable) return s;
  const sameSession = (p: Pending): boolean => !p.sid || !meta.sid || p.sid === meta.sid;
  const hit = Object.entries(s.pending).filter(([k, p]) => k === op || (meta.target !== undefined && sameSession(p) && sharesTarget(p.targets, [meta.target])));
  if (hit.length === 0) return { ...s, firstTry: s.firstTry + 1, updatedAt: now };
  let next: OneShotState = { ...s, corrected: s.corrected + 1, updatedAt: now, pending: { ...s.pending } };
  for (const [k, p] of hit) {
    const g = next.gates[p.title] ?? { denies: 0, corrected: 0, lastTs: 0 };
    delete next.pending[k];
    next = withEvent({ ...next, gates: { ...next.gates, [p.title]: { ...g, corrected: g.corrected + 1, lastTs: now } } },
      { ts: now, sid: meta.sid ?? p.sid, gate: p.title, op: k, target: meta.target ?? p.targets?.[0], outcome: "corrected" });
  }
  return next;
}

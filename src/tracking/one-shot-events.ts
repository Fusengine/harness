/**
 * @module one-shot-events
 * Deny-lifecycle event log of the one-shot metric: every deny, repeated deny,
 * fix and abandoned deny is one {@link OneShotEvent}, so a repeated deny and an
 * abandoned one are distinguishable (both used to look like "still pending").
 * @packageDocumentation
 */
import { parseEnvInt } from "../config/env";
import type { OneShotEvent, OneShotState, Pending } from "./one-shot-types";

/** Env var overriding how long a deny may stay pending before it is logged `abandoned`. */
export const ABANDON_ENV = "FUSE_ONESHOT_ABANDON_MS";

/** Abandon horizon (ms): `FUSE_ONESHOT_ABANDON_MS`, else the metric's own window (the only existing bound). */
export function resolveAbandonMs(windowMs: number, env: Record<string, string | undefined> = process.env): number {
  return parseEnvInt(env[ABANDON_ENV], windowMs);
}

/** Append `e` to the state's event log (immutable). */
export function withEvent(s: OneShotState, e: OneShotEvent): OneShotState {
  return { ...s, events: [...(s.events ?? []), e] };
}

/** True when `a` and `b` share a path. */
export function sharesTarget(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return !!a && !!b && a.some((t) => b.includes(t));
}

/**
 * Split pending denies at `abandonMs`: still-open ones stay, older ones are
 * dropped and logged as `abandoned`. Events older than `windowMs` are pruned.
 * `abandonMs` is clamped to `windowMs` (a pending never outlives the metric window).
 */
export function expirePending(s: OneShotState, now: number, abandonMs: number, windowMs: number): Pick<OneShotState, "pending" | "events"> {
  const limit = Math.min(abandonMs, windowMs);
  const pending: Record<string, Pending> = {};
  const events: OneShotEvent[] = (s.events ?? []).filter((e) => now - e.ts < windowMs);
  for (const [op, p] of Object.entries(s.pending)) {
    if (now - p.ts < limit) { pending[op] = p; continue; }
    events.push({ ts: now, sid: p.sid, gate: p.title, op, target: p.targets?.[0], outcome: "abandoned" });
  }
  return { pending, events };
}

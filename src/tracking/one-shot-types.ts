/**
 * @module one-shot-types
 * Data shapes of the per-gate one-shot metric ({@link module:one-shot-store}).
 * @packageDocumentation
 */

/** Per-gate tally: total denies, denies later fixed by an allow, last-seen clock. */
export interface GateStat { denies: number; corrected: number; lastTs: number; }

/**
 * One open deny awaiting its fix: the blocking gate title and when it landed.
 * `targets` (Bash-write denies only) are the absolute code-file paths the denied
 * command would have written — a later Write/Edit on one of them is the fix.
 * `sid` is the session that was denied. Both optional (older sidecars).
 */
export interface Pending { title: string; ts: number; targets?: string[]; sid?: string; }

/** What happened to a denied operation. */
export type OneShotOutcome = "denied" | "denied-again" | "corrected" | "abandoned";

/** One deny-lifecycle event: when, in which session, which gate, which op/target, what outcome. */
export interface OneShotEvent {
  ts: number;
  sid?: string;
  gate: string;
  op: string;
  target?: string;
  outcome: OneShotOutcome;
}

/** Aggregate one-shot state (a sidecar JSON). `pending` links a deny to its later allow. */
export interface OneShotState {
  gates: Record<string, GateStat>;
  firstTry: number;
  corrected: number;
  pending: Record<string, Pending>;
  updatedAt: number;
  /** Per-tool PostToolUseFailure tally. Optional — absent in pre-0.1.57 sidecars (additive, back-compatible). */
  failures?: Record<string, number>;
  /** Deny-lifecycle event log, pruned by the metric window. Optional — absent in older sidecars. */
  events?: OneShotEvent[];
}

/** A fresh, empty state — always spread (`{ ...EMPTY }`) so the const is never shared. */
export const EMPTY: OneShotState = { gates: {}, firstTry: 0, corrected: 0, pending: {}, updatedAt: 0 };

/**
 * Optional identity of a deny/allow beyond its content-free op key: the session,
 * the files a denied Bash write targets (`targets`), the file a Write/Edit allow
 * touched (`target`). All absolute, normalized paths.
 */
export interface OutcomeMeta { sid?: string; targets?: string[]; target?: string; }

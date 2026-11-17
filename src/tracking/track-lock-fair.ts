/**
 * @module track-lock-fair
 * Fairness primitives shared by the async (track-lock.ts) and blocking
 * (track-lock-sync.ts) track-lock takers: jittered capped backoff for a taker
 * that failed an attempt, and a release-side step-aside for a process that was
 * itself contended. A fixed-step poll is outrun by writers re-taking the lock
 * every ~0.5 ms (the rare taker, compaction, starved — H3 CI flake).
 * @packageDocumentation
 */

/**
 * Jittered, capped backoff for a failed attempt: uniform in 1..step ms with
 * step 1,2,4,8,8… — jitter de-correlates waiters from the holders' cycle
 * (no aliasing with a fixed poll step), the cap keeps the poll dense enough to
 * hit the sub-ms free windows. Never longer than the budget left.
 * @param attempt - Zero-based index of the failed attempt.
 * @param leftMs - Budget left (> 0).
 * @returns Whole milliseconds to sleep (>= 1).
 */
export function backoffMs(attempt: number, leftMs: number): number {
  const step = Math.min(1 << Math.min(attempt, 3), 8);
  return Math.max(1, Math.min(Math.ceil(Math.random() * step), Math.ceil(leftMs)));
}

/** How long after its own last failed attempt a process still counts the lock as contended. */
const CONTENDED_WINDOW_MS = 100;
/** Upper bound (4 ms) of the post-release step-aside: of the same order as the 1-8 ms waiter backoff, so at least some waiter polls inside it. */
const STEP_ASIDE_MAX_MS = 4;
/** Per-process: lockfile path -> `performance.now()` of this process's last failed attempt on it. */
const lastContended = new Map<string, number>();

/** Record that this process just failed an attempt on `lock` (arms {@link stepAsideMs}). */
export function markContended(lock: string): void {
  lastContended.set(lock, performance.now());
}

/**
 * Fairness: a bare `wx` lock lets the releasing process re-take a free lock
 * microseconds later, before any sleeping waiter polls. A process that saw
 * contention on `lock` recently steps aside 1..{@link STEP_ASIDE_MAX_MS} ms
 * after releasing it; uncontended callers never pay it.
 * @param lock - The lockfile path just released.
 * @returns Milliseconds to step aside (0 = none).
 */
export function stepAsideMs(lock: string): number {
  const at = lastContended.get(lock);
  if (at === undefined || performance.now() - at > CONTENDED_WINDOW_MS) return 0;
  return 1 + Math.floor(Math.random() * STEP_ASIDE_MAX_MS);
}

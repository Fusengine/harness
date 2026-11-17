/**
 * Synchronous twins of {@link withTrackLock} for lifecycle paths that CANNOT
 * float async work (the SubagentStop dispatch runs synchronously in a
 * short-lived hook process — an async write could be dropped before exit,
 * see `evidence-harvest-io.ts`). Same semantics: `wx` lockfile, the ONE shared
 * wait budget ({@link resolveTrackLockBudgetMs}), jittered backoff, release-side
 * step-aside, stale reclamation. The wait uses `Atomics.wait` (allowed on the
 * main thread in both Node and Bun).
 */
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveTrackLockBudgetMs } from "../config/limits";
import { isStale, LOCK_FAILED } from "./track-lock";
import { backoffMs, markContended, stepAsideMs } from "./track-lock-fair";

export { LOCK_FAILED } from "./track-lock";

/** Block the thread for `ms` (bounded by the caller's total budget). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Blocking twin of {@link withTrackLock}: waits out an in-flight compaction
 * (same `track.lock`) so an append never races its rename/fold/unlink. The
 * wait is FINITE: `budgetMs` of total spin (capped jittered backoff, the last
 * sleep clamped to the remaining budget) — a hook process must die by itself,
 * never pile up behind a busy lock. On expiry it returns {@link LOCK_FAILED}
 * WITHOUT running `fn`; the caller MUST NOT drop the work (track-journal
 * spills the event to a lock-free file instead). Stale-lock reclamation (dead
 * holder) still applies. Do NOT use where the lock may already be held.
 * @param dir - The track state directory (lockfile lives inside).
 * @param fn - The critical section (keep it minimal).
 * @param budgetMs - Total wait budget (default: `FUSE_TRACK_LOCK_BUDGET_MS`, 1000).
 * @returns `fn`'s result, or {@link LOCK_FAILED} when the budget expired.
 */
export function withTrackLockSyncBlocking<T>(
  dir: string,
  fn: () => T,
  budgetMs: number = resolveTrackLockBudgetMs(),
): T | typeof LOCK_FAILED {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "track.lock");
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      closeSync(fd);
      break;
    } catch {
      if (isStale(lock)) { try { unlinkSync(lock); } catch { /* raced */ } }
      markContended(lock);
      const left = deadline - performance.now();
      if (left <= 0) return LOCK_FAILED;
      sleepSync(backoffMs(attempt, left));
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* best-effort release */ }
    const aside = stepAsideMs(lock);
    if (aside > 0) sleepSync(aside);
  }
}

/**
 * Run `fn` under the track lock of `dir`, synchronously, or skip with a named
 * stderr note once the shared budget is spent (the callers' writes are
 * fail-open lifecycle updates: a named skip beats a hook that hangs).
 * @param dir - The track state directory (lockfile lives inside).
 * @param fn - The protected read-modify-write.
 * @returns `fn`'s result, or {@link LOCK_FAILED} when the lock stayed busy.
 */
export function withTrackLockSync<T>(dir: string, fn: () => T): T | typeof LOCK_FAILED {
  const out = withTrackLockSyncBlocking(dir, fn);
  if (out === LOCK_FAILED) process.stderr.write(`harness: track lock busy, write skipped (${join(dir, "track.lock")})\n`);
  return out;
}

/**
 * Synchronous twin of {@link withTrackLock} for lifecycle paths that CANNOT
 * float async work (the SubagentStop dispatch runs synchronously in a
 * short-lived hook process — an async write could be dropped before exit,
 * see `evidence-harvest-io.ts`). Same semantics: `wx` lockfile, bounded total
 * retry, named skipped write on contention, stale reclamation. The wait uses
 * `Atomics.wait` (allowed on the main thread in both Node and Bun).
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveTrackLockBudgetMs } from "../config/limits";
import { LOCK_FAILED, LOCK_RETRY_TOTAL_MS, LOCK_TTL_MS } from "./track-lock";

export { LOCK_FAILED } from "./track-lock";

/** Block the thread for `ms` (bounded by the caller's total budget). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when the lockfile is older than the TTL (orphaned by a dead process). */
function isStale(lock: string): boolean {
  try { return Date.now() - statSync(lock).mtimeMs > LOCK_TTL_MS; } catch { return false; }
}

/**
 * Run `fn` under the track lock of `dir`, synchronously.
 * @param dir - The track state directory (lockfile lives inside).
 * @param fn - The protected read-modify-write.
 * @returns `fn`'s result, or {@link LOCK_FAILED} when the lock stayed busy.
 */
export function withTrackLockSync<T>(dir: string, fn: () => T): T | typeof LOCK_FAILED {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "track.lock");
  const deadline = Date.now() + LOCK_RETRY_TOTAL_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      closeSync(fd);
      break;
    } catch {
      if (isStale(lock)) { try { unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() >= deadline) {
        process.stderr.write(`harness: track lock busy, write skipped (${lock})\n`);
        return LOCK_FAILED;
      }
      sleepSync(8);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* best-effort release */ }
  }
}

/** How long after its own last failed attempt a process still counts the lock as contended. */
const CONTENDED_WINDOW_MS = 100;
/** Upper bound (4 ms) of the post-release step-aside: of the same order as the 1-8 ms waiter backoff, so at least some waiter polls inside it. */
const STEP_ASIDE_MAX_MS = 4;
/** Per-process: lockfile path -> `performance.now()` of this process's last failed attempt on it. */
const lastContended = new Map<string, number>();

/**
 * Fairness: a bare `wx` lock lets the releasing process re-take a free lock
 * microseconds later, before any sleeping waiter polls, so under N writers one
 * can starve past its budget. A process that saw contention on `lock` recently
 * steps aside 1..{@link STEP_ASIDE_MAX_MS} ms after releasing it; uncontended
 * callers never pay it.
 */
function stepAsideIfContended(lock: string): void {
  const at = lastContended.get(lock);
  if (at === undefined || performance.now() - at > CONTENDED_WINDOW_MS) return;
  sleepSync(1 + Math.floor(Math.random() * STEP_ASIDE_MAX_MS));
}

/**
 * Blocking twin of {@link withTrackLockSync}: waits out an in-flight
 * compaction (same `track.lock`) so an append never races its
 * rename/fold/unlink. The wait is FINITE: `budgetMs` of total spin (capped
 * jittered backoff, the last sleep clamped to the remaining budget) — a hook
 * process must die by itself, never pile up behind a busy lock. On expiry it
 * returns {@link LOCK_FAILED} WITHOUT running `fn`; the caller MUST NOT drop
 * the work (track-journal spills the event to a lock-free file instead).
 * Stale-lock reclamation (dead holder) still applies. Do NOT use where the
 * lock may already be held.
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
      lastContended.set(lock, performance.now());
      const left = deadline - performance.now();
      if (left <= 0) return LOCK_FAILED;
      const step = Math.min(1 << Math.min(attempt, 3), 8); // 1,2,4,8,8… ms
      sleepSync(Math.max(1, Math.min(Math.ceil(Math.random() * step), Math.ceil(left))));
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* best-effort release */ }
    stepAsideIfContended(lock);
  }
}


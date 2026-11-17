/**
 * Cross-process lock for session-track read-modify-write. The ~11-hook
 * fan-out races plain `loadTrack → mutate → saveTrack` (writes silently
 * lost — `refsRead` was the only mitigated channel, via its journal). This
 * lockfile (`wx`, atomic create) serializes the whole RMW:
 * - ONE shared wait budget for every taker ({@link resolveTrackLockBudgetMs},
 *   `FUSE_TRACK_LOCK_BUDGET_MS`, default 1000 ms — far under any hook timeout),
 *   polled with the SAME jittered backoff and release-side step-aside as the
 *   sync twins (track-lock-fair.ts). The former fixed 8 ms poll was outrun by
 *   writers re-taking the lock every ~0.5 ms: the rare taker (compaction)
 *   starved and the H3 test flaked with "write skipped";
 * - after the budget, NEVER crash: stderr is logged and the caller decides
 *   (track writes spill, see store.ts / track-spill.ts) — a named outcome beats
 *   a fail-open crash (hook fail-open semantics preserved);
 * - an orphaned lockfile (dead process) is reclaimed after a 10 s TTL, so a
 *   crash mid-write never blocks a project forever.
 */
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveTrackLockBudgetMs } from "../config/limits";
import { backoffMs, markContended, stepAsideMs } from "./track-lock-fair";

/** Orphaned lockfile lifetime before reclamation. */
export const LOCK_TTL_MS = 10_000;

/** Sentinel returned by {@link withTrackLock} when the lock could not be taken. */
export const LOCK_FAILED: unique symbol = Symbol("track-lock-failed");

/** True when the lockfile is older than the TTL (orphaned by a dead process). */
export function isStale(lock: string): boolean {
  try { return Date.now() - statSync(lock).mtimeMs > LOCK_TTL_MS; } catch { return false; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` under the track lock of `dir`, or skip with a stderr note once the
 * shared budget is spent. Async twin: waiting yields the event loop, so use it
 * (not the blocking twin) where `fn` or a sibling task awaits in-process.
 * @param dir - The track state directory (lockfile lives inside).
 * @param fn - The protected read-modify-write.
 * @param budgetMs - Total wait budget (default: `FUSE_TRACK_LOCK_BUDGET_MS`, 1000).
 * @returns `fn`'s result, or {@link LOCK_FAILED} when the lock stayed busy.
 */
export async function withTrackLock<T>(
  dir: string,
  fn: () => Promise<T>,
  budgetMs: number = resolveTrackLockBudgetMs(),
): Promise<T | typeof LOCK_FAILED> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "track.lock");
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      closeSync(fd);
      break;
    } catch {
      if (isStale(lock)) { try { unlinkSync(lock); } catch { /* raced */ } continue; }
      markContended(lock);
      const left = deadline - performance.now();
      if (left <= 0) {
        process.stderr.write(`harness: track lock busy, write skipped (${lock})\n`);
        return LOCK_FAILED;
      }
      await sleep(backoffMs(attempt, left));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* best-effort release */ }
    const aside = stepAsideMs(lock);
    if (aside > 0) await sleep(aside);
  }
}

/** Test helper: true when a lockfile currently exists in `dir`. */
export function trackLockExists(dir: string): boolean {
  return existsSync(join(dir, "track.lock"));
}

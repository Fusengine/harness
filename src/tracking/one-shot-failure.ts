/**
 * @module one-shot-failure
 * PostToolUseFailure tally for the one-shot sidecar. A pure per-tool counter
 * ({@link applyFailure}) plus its burst-deduped IO writer ({@link recordFailure}),
 * kept out of {@link module:one-shot-store} so that file stays under the SOLID
 * size limit. Reuses the SAME sidecar, prune window, and burst-dedup as
 * {@link module:one-shot} — failures never touch the deny/allow gate rate.
 * @packageDocumentation
 */
import { join } from "node:path";
import { atomicWrite } from "../util/json-io";
import { pruneState, type OneShotState } from "./one-shot-store";
import { SIDECAR, WINDOW_MS, loadState, type OneShotOpts } from "./one-shot";
import { burstFirst } from "./one-shot-dedup";
import { resolveAbandonMs } from "./one-shot-events";

/**
 * Bump the per-tool failure count. Orthogonal to gates/pending, so it can never
 * distort the one-shot rate.
 * @param s - Current state.
 * @param tool - The failing tool name (`unknown` when absent).
 * @param now - Clock.
 * @returns The next state with `failures[tool]` incremented.
 */
export function applyFailure(s: OneShotState, tool: string, now: number): OneShotState {
  return { ...s, failures: { ...(s.failures ?? {}), [tool]: (s.failures?.[tool] ?? 0) + 1 }, updatedAt: now };
}

/**
 * Persist a PostToolUseFailure into the one-shot sidecar, burst-deduped across the
 * ~11-process fan-out (same window/store as {@link recordOneShot}). Fail-safe: a
 * write error never propagates out of the hook.
 * @param tool - The failing tool name.
 * @param opts - Clock + state dir + optional session id (arms the burst dedup).
 */
export function recordFailure(tool: string, opts: OneShotOpts): void {
  try {
    if (!burstFirst(`fail:${tool}`, "failure", opts)) return;
    const path = join(opts.dir, SIDECAR);
    const next = applyFailure(pruneState(loadState(path), opts.now, WINDOW_MS, resolveAbandonMs(WINDOW_MS)), tool, opts.now);
    atomicWrite(path, JSON.stringify(next));
  } catch { /* fail-safe: metrics never break the hook */ }
}

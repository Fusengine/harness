/**
 * @module one-shot
 * Sidecar store + gate wiring for the per-gate one-shot metric.
 *
 * STATE — a standalone sidecar (`one-shot.json`) in the same per-project state dir
 * as the session track, mirroring {@link module:deny-loop-store} (atomicWrite,
 * prune-by-window, fail-safe). A write error NEVER changes a gate decision nor its
 * prompt — metrics are pure observation.
 *
 * KEY — the operation identity is content-FREE (`tool + filePath/command`): a fix
 * changes the content, so a content hash would make every retry a new op and hide
 * the deny→allow transition this metric exists to see. The pure model lives in
 * {@link module:one-shot-store}; this file is the only IO surface.
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../util/json-io";
import { denyHash } from "../policy/deny-loop";
import { projectStateDir } from "../runtime/project-state-dir";
import { applyAllow, applyDeny, EMPTY, formatSummary, pruneState, type OneShotState } from "./one-shot-store";
import { burstFirst } from "./one-shot-dedup";
import type { Prompt } from "../prompt/types";

/** Sidecar basename under the per-project state dir. */
export const SIDECAR = "one-shot.json";

/** Retention window: 7 days. Aggregates and pending denies older than this are pruned. */
export const WINDOW_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * Injected clock + state dir (no env var; the gate supplies both). `sessionId` —
 * when present — arms the burst dedup ({@link module:one-shot-dedup}) so the ~11
 * sibling plugin hooks of ONE event count once, not once each. Omitted by
 * mono-process callers/tests → un-deduped historical behaviour.
 */
export interface OneShotOpts { now: number; dir: string; sessionId?: string; }

/** Identifying tool input (content-free); `content` only decides gateability. */
export interface OneShotInput { filePath?: string; content?: string; command?: string; }

/** Load the state, or a fresh copy when missing/corrupt. */
export function loadState(path: string): OneShotState {
  try {
    if (!existsSync(path)) return { ...EMPTY };
    const d: unknown = JSON.parse(readFileSync(path, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? { ...EMPTY, ...(d as OneShotState) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Record a gate outcome: a `block` is a deny for its gate title; a `null` allow is
 * a fix (if the op was pending) or a one-shot (if gateable). `ask`/`inform` are
 * neither and are skipped. Fails silently — a metric write NEVER affects a decision.
 *
 * The op key is tool-INDEPENDENT (`filePath`/`command` only, constant `"op"` tool):
 * a deny (a `Write`) and its fix (an `Edit`) on the same file must link.
 * @param prompt - The gate's outcome (block, allow=null, or ask/inform).
 * @param input - Identifying tool input (content decides gateability only).
 * @param opts - Clock + state dir.
 */
export function recordOneShot(prompt: Prompt | null, input: OneShotInput, opts: OneShotOpts): void {
  try {
    if (prompt && prompt.kind !== "block") return;
    const op = denyHash("op", { filePath: input.filePath, command: input.command });
    if (!burstFirst(op, prompt ? `deny:${prompt.title}` : "allow", opts)) return;
    const path = join(opts.dir, SIDECAR);
    let s = pruneState(loadState(path), opts.now, WINDOW_MS);
    s = prompt
      ? applyDeny(s, prompt.title, op, opts.now)
      : applyAllow(s, op, opts.now, input.content != null || input.command != null);
    atomicWrite(path, JSON.stringify(s));
  } catch { /* fail-safe: metrics never change a gate decision */ }
}

/**
 * Compact, injection-ready one-shot summary for the project rooted at `cwd`. The
 * state dir is derived EXACTLY like the runtime writer ({@link projectStateDir},
 * mirroring `handle.ts` `trackFile(sid, projectStateDir(cwd))`), so the file read
 * here is the same one {@link recordOneShot} wrote. "" when no data or read error.
 * @param cwd - The project working directory (Claude `cwd`), NOT the state dir.
 * @returns One line, e.g. `gates 7d: 88% one-shot (44/50 clean); ...`, or "".
 */
export function oneShotSummary(cwd: string): string {
  try {
    const s = pruneState(loadState(join(projectStateDir(cwd), SIDECAR)), Date.now(), WINDOW_MS);
    return formatSummary(s);
  } catch {
    return "";
  }
}

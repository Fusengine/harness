/**
 * Shared plumbing for `status`/`validate`/`compact`: root+env resolution,
 * the `FUSE_PRD` write gate, task-PRD lookup, and the `.lock`-guarded write.
 * All return a result instead of calling `process.exit` themselves —
 * callers own the exit code (extracted to kill a jscpd-measured clone
 * across the three `run*` functions).
 */
import { join } from "node:path";
import { prdDir, prdRouterPath } from "../../policy/prd/prd-paths";
import { readRouterState, readTaskFile } from "../../policy/prd/prd-io";
import { describeRouterState } from "../../policy/prd/prd-router-state";
import { isPrdFlagSet } from "../../policy/prd/prd-enabled";
import type { PrdRouter, PrdRouterEntry, PrdTaskFile } from "../../policy/prd/interfaces/types";
import { acquireLock } from "../../runtime/lifecycle/aipilot/apex-task-store";
import { positionalArgs, resolveAndLoadEnv } from "./resolve";

/** `{root, homeSeg}` on success, or an exit code + message on failure. */
export type PrdStepResult = { ok: true; root: string; homeSeg: string } | { ok: false; code: number; message: string };

/** {@link resolveAndLoadEnv}, narrowed to `{root, homeSeg}` — the common first step of every sub-command. */
export function resolveRoot(argv: string[], cwd: string, env: NodeJS.ProcessEnv): PrdStepResult {
  const resolved = resolveAndLoadEnv(argv, cwd, env);
  if (!resolved.ok) return { ok: false, code: 2, message: resolved.message };
  return { ok: true, root: resolved.value.root, homeSeg: resolved.value.homeSeg };
}

/** {@link resolveRoot} + the `FUSE_PRD=1` write gate shared by `validate`/`compact`. */
export function requireFusePrd(argv: string[], cwd: string, env: NodeJS.ProcessEnv, sub: string): PrdStepResult {
  const resolved = resolveRoot(argv, cwd, env);
  if (!resolved.ok) return resolved;
  if (!isPrdFlagSet(env)) {
    return { ok: false, code: 1, message: `prd ${sub} requires FUSE_PRD=1 in ${resolved.homeSeg}/.env or the project .env` };
  }
  return resolved;
}

/** Result of {@link loadTaskFileFor}: the resolved router/task-PRD, or a usage error. */
export type PrdTaskLookup =
  | { ok: true; router: PrdRouter; routerEntry: PrdRouterEntry; taskFile: PrdTaskFile }
  | { ok: false; code: 2; message: string };

/** Reads the router + the named task's task-PRD file. Never calls `process.exit`. */
export async function loadTaskFileFor(root: string, homeSeg: string, task: string): Promise<PrdTaskLookup> {
  const state = await readRouterState(root, homeSeg);
  if (state.state !== "ok") return { ok: false, code: 2, message: describeRouterState(state, prdRouterPath(root, homeSeg)) };
  const router = state.router;
  const routerEntry = router[task];
  if (!routerEntry) return { ok: false, code: 2, message: `no such task "${task}" in PRD router` };

  const taskFile = await readTaskFile(root, homeSeg, routerEntry.prd);
  if (!taskFile) return { ok: false, code: 2, message: `task PRD not found or malformed: ${routerEntry.prd}` };

  return { ok: true, router, routerEntry, taskFile };
}

/** Result of {@link resolveTaskFile}: the `<task>` positional plus its looked-up files, or a usage/lookup error. */
export type PrdTaskArgLookup =
  | { ok: true; task: string; agentArg: string | undefined; router: PrdRouter; routerEntry: PrdRouterEntry; taskFile: PrdTaskFile }
  | { ok: false; code: 2; message: string };

/** Extracts `<task> [agent]` from argv, then {@link loadTaskFileFor} — the shared `validate`/`compact` entry lookup. */
export async function resolveTaskFile(argv: string[], root: string, homeSeg: string, usage: string): Promise<PrdTaskArgLookup> {
  const [task, agentArg] = positionalArgs(argv);
  if (!task) return { ok: false, code: 2, message: usage };
  const lookup = await loadTaskFileFor(root, homeSeg, task);
  if (!lookup.ok) return lookup;
  return { task, agentArg, ...lookup };
}

/** Result of {@link withPrdLock}. */
export type PrdLockResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Runs `fn` under the PRD `.lock` directory-lock. Never calls `process.exit`. */
export async function withPrdLock<T>(root: string, homeSeg: string, fn: () => Promise<T>): Promise<PrdLockResult<T>> {
  const lockDir = join(prdDir(root, homeSeg), ".lock");
  const release = await acquireLock(lockDir);
  if (!release) return { ok: false, message: `lock held at ${lockDir}` };
  try {
    return { ok: true, value: await fn() };
  } finally {
    await release();
  }
}

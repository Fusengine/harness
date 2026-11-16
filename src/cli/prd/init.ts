/**
 * `harness prd init [--task <id>] [--id] [--root]` — bootstraps the PRD router.
 * The module is inert until `<home>/apex/prd.json` exists, and the lead cannot
 * Write that path (protectedPathGuard) — so the CLI creates it. Creation is
 * atomic and never clobbers (temp file + `link`, which fails on `EEXIST`); an
 * existing router is never rewritten. Requires `FUSE_PRD=1`.
 */
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { prdRouterPath } from "../../policy/prd/prd-paths";
import { readRouterSnapshotSync } from "../../policy/prd/prd-io";
import { classifyRouterText, describeRouterState } from "../../policy/prd/prd-router-state";
import type { PrdRouter } from "../../policy/prd/interfaces/types";
import { readFlag } from "./resolve";
import { requireFusePrd } from "./shared";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The `--task` value (`undefined` when the flag is absent); `null` when present but not a valid task id. */
function parseTask(argv: string[]): string | undefined | null {
  if (argv.some((a) => a.startsWith("--task="))) return null; // long flags take a separate value
  if (!argv.includes("--task")) return undefined;
  const value = readFlag(argv, "--task");
  return value !== undefined && TASK_ID.test(value) ? value : null;
}

/** Router text for a fresh router, checked against the real router classifier before it is ever written. */
function initialRouterText(task: string | undefined): string {
  const router: PrdRouter = task === undefined ? {} : { [task]: { prd: `prd/${task}-prd.json`, status: "assigned" } };
  const text = JSON.stringify(router, null, 2);
  if (classifyRouterText(text).state !== "ok") throw new Error("prd init: generated router fails the router schema");
  return text;
}

/** Creates `path` with `text` only if it does not exist; `false` when another writer got there first. */
function createExclusive(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* temp already gone */ }
  }
}

/**
 * Outcome for a router that already exists (or appeared concurrently): 0 when valid and it
 * holds `task` (or none was asked), 1 otherwise. Never writes.
 */
function existingRouterCode(root: string, homeSeg: string, task: string | undefined): number {
  const path = prdRouterPath(root, homeSeg);
  const { state } = readRouterSnapshotSync(root, homeSeg);
  if (state.state !== "ok") {
    process.stderr.write(`prd init: ${describeRouterState(state, path)}\n`);
    return 1;
  }
  if (task !== undefined && !Object.hasOwn(state.router, task)) {
    process.stderr.write(`prd init: router ${path} exists without task "${task}" — add it with a Write (init never rewrites an existing router)\n`);
    return 1;
  }
  process.stdout.write(`prd init: router already present at ${path}\n`);
  return 0;
}

/**
 * Run `harness prd init`. Exit 0 when the router was created or already valid,
 * 1 for a missing `FUSE_PRD=1`, a malformed router, or an existing router lacking
 * `--task`, 2 for usage errors (bad `--task`, unresolvable harness).
 */
export async function runPrdInit(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const task = parseTask(argv);
  if (task === null) {
    process.stderr.write(`usage: harness prd init [--task <id>] [--id <harness>] [--root <dir>] — <id> must match ${TASK_ID}\n`);
    return 2;
  }
  const resolved = requireFusePrd(argv, cwd, env, "init", { allowNoRouter: true });
  if (!resolved.ok) {
    process.stderr.write(resolved.message + "\n");
    return resolved.code;
  }
  const { root, homeSeg } = resolved;

  const { state } = readRouterSnapshotSync(root, homeSeg);
  if (state.state === "absent") {
    try {
      if (createExclusive(prdRouterPath(root, homeSeg), initialRouterText(task))) {
        process.stdout.write(`prd init: created ${prdRouterPath(root, homeSeg)}${task ? ` with task "${task}"` : ""}\n`);
        return 0;
      }
    } catch (err) {
      process.stderr.write(`prd init: cannot create router: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  return existingRouterCode(root, homeSeg, task);
}

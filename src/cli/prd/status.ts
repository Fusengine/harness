/**
 * `harness prd status [--json] [--id <harness>] [--root <dir>]` — read-only
 * PRD snapshot. Never requires `FUSE_PRD`. Exit 0 on success, exit 1 when no
 * router is found, exit 2 on an unresolved/ambiguous `--id`.
 */
import { prdRouterPath } from "../../policy/prd/prd-paths";
import { readAgentReport, readAllTaskFiles, readRouterState } from "../../policy/prd/prd-io";
import { describeRouterState } from "../../policy/prd/prd-router-state";
import { crossCheckTask } from "../../policy/prd/prd-crosscheck";
import { isCompacted, subTasksOf } from "../../policy/prd/prd-schema";
import type { PrdAgentReportFile, PrdTaskFile } from "../../policy/prd/interfaces/types";
import { hasJsonFlag } from "./resolve";
import { renderJson, renderTable } from "./format";
import { resolveRoot } from "./shared";

const HEADER: string[] = ["Task", "Router status", "Agents", "Sub-tasks done/total", "Violations"];

/**
 * Sub-task readiness counts for the "done/total" column: a sub-task counts as
 * done once it is `validated` OR its owning agent's own report already shows
 * `"done"` for it (readiness view — a report can land well before the
 * coordinator runs `prd validate`). A compacted (fully-validated) entry
 * counts as one done/one total unit — its per-sub-task detail is gone.
 */
function subTaskCounts(
  taskFile: PrdTaskFile,
  reports: Record<string, PrdAgentReportFile | null>,
  task: string,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const [agent, entry] of Object.entries(taskFile)) {
    if (isCompacted(entry)) {
      done++;
      total++;
      continue;
    }
    const report = reports[agent];
    for (const [sub, subTask] of Object.entries(subTasksOf(entry))) {
      total++;
      if (subTask.status === "validated" || report?.[task]?.[sub]?.status === "done") done++;
    }
  }
  return { done, total };
}

/**
 * Run `harness prd status`. Prints an aligned table (or `--json` dump of
 * `{router, taskFiles, reports}`) and returns the process exit code.
 */
export async function runPrdStatus(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const resolved = resolveRoot(argv, cwd, env);
  if (!resolved.ok) {
    process.stderr.write(resolved.message + "\n");
    return resolved.code;
  }
  const { root, homeSeg } = resolved;

  const state = await readRouterState(root, homeSeg);
  if (state.state !== "ok") {
    process.stderr.write(`${describeRouterState(state, prdRouterPath(root, homeSeg))}\n`);
    return 1;
  }
  const router = state.router;

  const taskFiles = await readAllTaskFiles(root, homeSeg, router);
  const agentNames = new Set<string>();
  for (const tf of Object.values(taskFiles)) {
    if (tf) for (const agent of Object.keys(tf)) agentNames.add(agent);
  }
  const reports: Record<string, PrdAgentReportFile | null> = {};
  for (const agent of agentNames) reports[agent] = await readAgentReport(root, homeSeg, agent);

  if (hasJsonFlag(argv)) {
    process.stdout.write(renderJson({ router, taskFiles, reports }));
    return 0;
  }

  const rows: string[][] = [];
  for (const [task, entry] of Object.entries(router)) {
    const tf = taskFiles[task];
    const agentCount = tf ? Object.keys(tf).length : 0;
    const { done, total } = tf ? subTaskCounts(tf, reports, task) : { done: 0, total: 0 };
    const violations = tf ? crossCheckTask(tf, reports as Record<string, PrdAgentReportFile>, task) : [];
    rows.push([task, entry.status, String(agentCount), `${done}/${total}`, String(violations.length)]);
  }
  process.stdout.write(renderTable(HEADER, rows) + "\n");
  return 0;
}

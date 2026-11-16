/**
 * `harness prd validate <task> [agent] [--id] [--root]` — cross-checks a
 * task-PRD against the named agent(s)' own report(s); on success flips the
 * matching sub-tasks to `validated` and promotes the router entry when every
 * agent is fully validated. Requires `FUSE_PRD=1`.
 */
import { readAgentReport, writeRouter, writeTaskFile } from "../../policy/prd/prd-io";
import { incompleteSubTasks } from "../../policy/prd/prd-crosscheck";
import { isCompacted, subTasksOf, withRouterStatus, withSubTaskValidated } from "../../policy/prd/prd-schema";
import type { PrdAgentReportFile, PrdCrossCheckViolation, PrdTaskFile } from "../../policy/prd/interfaces/types";
import { requireTaskFile, withPrdLock } from "./shared";

function allValidated(taskFile: PrdTaskFile): boolean {
  return Object.values(taskFile).every(
    (entry) => isCompacted(entry) || Object.values(subTasksOf(entry)).every((s) => s.status === "validated"),
  );
}

/**
 * Sub-tasks of `agents` with no matching `done` entry in their owning
 * agent's own report — the readiness gate `validate` enforces before
 * flipping anything. Reuses `incompleteSubTasks` (distinct from
 * `crossCheckTask`, which only flags an ALREADY-`validated` sub-task lacking
 * a report; here nothing has been validated yet).
 */
function findUnreadySubTasks(
  taskFile: PrdTaskFile,
  reports: Record<string, PrdAgentReportFile | null>,
  task: string,
  agents: string[],
): PrdCrossCheckViolation[] {
  const out: PrdCrossCheckViolation[] = [];
  for (const agent of agents) {
    const missing = incompleteSubTasks(taskFile, agent, task, reports[agent] ?? null);
    for (const sub of missing) out.push({ task, agent, sub, reason: `no "done" report from "${agent}" for sub-task "${sub}"` });
  }
  return out;
}

/**
 * Run `harness prd validate`. Exit 0 on success, exit 1 on cross-check
 * violations or a missing `FUSE_PRD=1`/held lock, exit 2 on usage/lookup errors.
 */
export async function runPrdValidate(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const tf = await requireTaskFile(argv, cwd, env, "validate", "usage: harness prd validate <task> [agent]");
  if (!tf.ok) {
    process.stderr.write(tf.message + "\n");
    return tf.code;
  }
  const { root, homeSeg, task, agentArg, router, routerEntry, taskFile } = tf;
  if (agentArg && !(agentArg in taskFile)) {
    process.stderr.write(`no such agent "${agentArg}" in task PRD for "${task}"\n`);
    return 2;
  }

  const agents = agentArg ? [agentArg] : Object.keys(taskFile);
  const reports: Record<string, PrdAgentReportFile | null> = {};
  for (const agent of Object.keys(taskFile)) reports[agent] = await readAgentReport(root, homeSeg, agent);

  const violations = findUnreadySubTasks(taskFile, reports, task, agents);
  if (violations.length > 0) {
    process.stderr.write(`prd validate: ${violations.length} violation(s)\n`);
    for (const v of violations) process.stderr.write(`  - ${v.task}/${v.agent}/${v.sub}: ${v.reason}\n`);
    return 1;
  }

  const result = await withPrdLock(root, homeSeg, async () => {
    const now = new Date().toISOString();
    let updated = taskFile;
    for (const agent of agents) {
      const entry = updated[agent];
      if (!entry || isCompacted(entry)) continue;
      for (const sub of Object.keys(subTasksOf(entry))) updated = withSubTaskValidated(updated, agent, sub, now);
    }
    await writeTaskFile(root, homeSeg, routerEntry.prd, updated);
    if (allValidated(updated)) await writeRouter(root, homeSeg, withRouterStatus(router, task, "validated", now));
  });
  if (!result.ok) {
    process.stderr.write(`prd validate: ${result.message}\n`);
    return 1;
  }
  return 0;
}

/**
 * Cross-checks a task-PRD's declared status against the agents' own reports
 * (and, for the router, against the task-PRD's own internal consistency).
 * Pure — no fs.
 */
import { isCompacted, subTasksOf } from "./prd-schema";
import type {
  PrdAgentReportFile, PrdCrossCheckViolation, PrdRouter, PrdTaskFile,
} from "./interfaces/types";

/** Mismatches between a task-PRD's `validated` sub-tasks and the agents' own reports. */
export function crossCheckTask(
  taskFile: PrdTaskFile,
  reports: Record<string, PrdAgentReportFile>,
  task: string,
): PrdCrossCheckViolation[] {
  const violations: PrdCrossCheckViolation[] = [];
  for (const [agent, entry] of Object.entries(taskFile)) {
    if (isCompacted(entry)) continue;
    const report = reports[agent];
    for (const [sub, subTask] of Object.entries(subTasksOf(entry))) {
      if (subTask.status !== "validated") continue;
      if (report?.[task]?.[sub]?.status !== "done") {
        violations.push({ task, agent, sub, reason: "validated without a matching done report" });
      }
    }
  }
  return violations;
}

function taskFullyValidated(taskFile: PrdTaskFile): boolean {
  return Object.values(taskFile).every((entry) => {
    if (isCompacted(entry)) return true;
    return Object.values(subTasksOf(entry)).every((sub) => sub.status === "validated");
  });
}

/**
 * Router-level consistency check: a router entry marked `validated` whose
 * task-PRD is missing/unparseable, or not actually fully validated, is a
 * violation. Non-`validated` router entries are never checked.
 */
export function crossCheckRouter(
  router: PrdRouter,
  taskFiles: Record<string, PrdTaskFile | null>,
): PrdCrossCheckViolation[] {
  const violations: PrdCrossCheckViolation[] = [];
  for (const [task, entry] of Object.entries(router)) {
    if (entry.status !== "validated") continue;
    const taskFile = taskFiles[task];
    if (!taskFile) {
      violations.push({ task, agent: "*", sub: "*", reason: "router marked validated but task-PRD is missing or unparseable" });
    } else if (!taskFullyValidated(taskFile)) {
      violations.push({ task, agent: "*", sub: "*", reason: "router marked validated but task-PRD is not fully validated" });
    }
  }
  return violations;
}

/** Sub-tasks assigned to `agent` in `taskFile` for `task` not `done` in its own report. */
export function incompleteSubTasks(
  taskFile: PrdTaskFile,
  agent: string,
  task: string,
  report: PrdAgentReportFile | null,
): string[] {
  const entry = taskFile[agent];
  if (!entry || isCompacted(entry)) return [];
  const doneSubs = report?.[task] ?? {};
  return Object.keys(subTasksOf(entry)).filter((sub) => doneSubs[sub]?.status !== "done");
}

/**
 * True when slot `agent` is closed: declared by at least one task-PRD, and in
 * every task declaring it either compacted, or each sub-task `validated` or
 * reported `done` in `report` (the slot's own report on disk). An expanded
 * entry without sub-tasks is never closed. Pure — the caller reads the disk.
 */
export function isSlotClosed(
  agent: string,
  taskFiles: Record<string, PrdTaskFile | null>,
  report: PrdAgentReportFile | null,
): boolean {
  let declared = false;
  for (const [task, taskFile] of Object.entries(taskFiles)) {
    if (!taskFile || !Object.hasOwn(taskFile, agent)) continue;
    const entry = taskFile[agent];
    if (!entry) continue;
    declared = true;
    if (isCompacted(entry)) continue;
    const subs = Object.entries(subTasksOf(entry));
    if (subs.length === 0) return false;
    for (const [sub, subTask] of subs) {
      if (subTask.status !== "validated" && report?.[task]?.[sub]?.status !== "done") return false;
    }
  }
  return declared;
}

/** True when the router has any `validated`-vs-task-PRD mismatch. */
export function hasAnyViolations(router: PrdRouter, taskFiles: Record<string, PrdTaskFile | null>): boolean {
  return crossCheckRouter(router, taskFiles).length > 0;
}

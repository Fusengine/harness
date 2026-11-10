/**
 * Fail-closed parsers (malformed input -> `null`, never throw) and small
 * immutable builders for the PRD JSON contract. Pure — no fs.
 */
import type {
  PrdAgentEntryCompacted, PrdAgentReportFile, PrdRouter, PrdRouterEntry, PrdRouterStatus,
  PrdSubTask, PrdTaskAgentEntry, PrdTaskFile,
} from "./interfaces/types";

/** The router statuses the schema accepts (also used to word schema diagnostics). */
export const ROUTER_STATUSES: readonly PrdRouterStatus[] = ["assigned", "in-progress", "validated"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseRouterEntry(v: unknown): PrdRouterEntry | null {
  if (!isRecord(v)) return null;
  if (typeof v.prd !== "string") return null;
  if (typeof v.status !== "string" || !ROUTER_STATUSES.includes(v.status as PrdRouterStatus)) return null;
  const validatedAt = v["validated-at"];
  if (validatedAt !== undefined && typeof validatedAt !== "string") return null;
  return validatedAt === undefined
    ? { prd: v.prd, status: v.status as PrdRouterStatus }
    : { prd: v.prd, status: v.status as PrdRouterStatus, "validated-at": validatedAt };
}

/** Parses the router file (`prd.json`); `null` on any malformed shape. */
export function parseRouter(raw: unknown): PrdRouter | null {
  if (!isRecord(raw)) return null;
  const out: PrdRouter = {};
  for (const [task, v] of Object.entries(raw)) {
    const entry = parseRouterEntry(v);
    if (!entry) return null;
    out[task] = entry;
  }
  return out;
}

function parseSubTask(v: unknown): PrdSubTask | null {
  if (!isRecord(v) || typeof v.status !== "string") return null;
  if (v.status !== "assigned" && v.status !== "validated") return null;
  const validatedAt = v["validated-at"];
  if (validatedAt !== undefined && typeof validatedAt !== "string") return null;
  return validatedAt === undefined ? { status: v.status } : { status: v.status, "validated-at": validatedAt };
}

function parseAgentEntry(v: unknown): PrdTaskAgentEntry | null {
  if (!isRecord(v) || !isStringArray(v.files)) return null;
  if (v.status === "validated") {
    if (typeof v["validated-at"] !== "string") return null;
    return { status: "validated", files: v.files, "validated-at": v["validated-at"] };
  }
  if (!isRecord(v["sub-tasks"])) return null;
  const subTasks: Record<string, PrdSubTask> = {};
  for (const [sub, sv] of Object.entries(v["sub-tasks"])) {
    const parsed = parseSubTask(sv);
    if (!parsed) return null;
    subTasks[sub] = parsed;
  }
  return { files: v.files, "sub-tasks": subTasks };
}

/** Parses a task-PRD file; `null` on any malformed shape. */
export function parseTaskFile(raw: unknown): PrdTaskFile | null {
  if (!isRecord(raw)) return null;
  const out: PrdTaskFile = {};
  for (const [agent, v] of Object.entries(raw)) {
    const entry = parseAgentEntry(v);
    if (!entry) return null;
    out[agent] = entry;
  }
  return out;
}

/** Parses an agent's own report file; `null` on any malformed shape. */
export function parseAgentReportFile(raw: unknown): PrdAgentReportFile | null {
  if (!isRecord(raw)) return null;
  const out: PrdAgentReportFile = {};
  for (const [task, subs] of Object.entries(raw)) {
    if (!isRecord(subs)) return null;
    const parsedSubs: Record<string, PrdAgentReportFile[string][string]> = {};
    for (const [sub, v] of Object.entries(subs)) {
      if (!isRecord(v) || v.status !== "done" || !isStringArray(v.modified) || !isStringArray(v.unchanged)) {
        return null;
      }
      const doneAt = v["done-at"];
      if (doneAt !== undefined && typeof doneAt !== "string") return null;
      parsedSubs[sub] = doneAt === undefined
        ? { status: "done", modified: v.modified, unchanged: v.unchanged }
        : { status: "done", modified: v.modified, unchanged: v.unchanged, "done-at": doneAt };
    }
    out[task] = parsedSubs;
  }
  return out;
}

/** True when `e` is the post-compaction shape. */
export function isCompacted(e: PrdTaskAgentEntry): e is PrdAgentEntryCompacted {
  return "status" in e && e.status === "validated" && !("sub-tasks" in e);
}

/** Sub-tasks of an agent entry; `{}` when already compacted. */
export function subTasksOf(e: PrdTaskAgentEntry): Record<string, PrdSubTask> {
  return isCompacted(e) ? {} : e["sub-tasks"];
}

/** Files owned by an agent entry, expanded or compacted. */
export function filesOf(e: PrdTaskAgentEntry): string[] {
  return e.files;
}

/** `["needs >= 2 agents", ...]` — empty when the task PRD satisfies the contract. */
export function validateTaskFileInvariant(taskFile: PrdTaskFile): string[] {
  const errors: string[] = [];
  if (Object.keys(taskFile).length < 2) errors.push("needs >= 2 agents");
  return errors;
}

/** Returns a new router with `task`'s status (and optional `validated-at`) updated. */
export function withRouterStatus(
  router: PrdRouter,
  task: string,
  status: PrdRouterStatus,
  at?: string,
): PrdRouter {
  const existing = router[task];
  if (!existing) return router;
  const entry: PrdRouterEntry = at === undefined
    ? { prd: existing.prd, status }
    : { prd: existing.prd, status, "validated-at": at };
  return { ...router, [task]: entry };
}

/** Returns a new task-PRD file with one agent's sub-task flipped to `validated`. */
export function withSubTaskValidated(
  taskFile: PrdTaskFile,
  agent: string,
  sub: string,
  at: string,
): PrdTaskFile {
  const entry = taskFile[agent];
  if (!entry || isCompacted(entry)) return taskFile;
  const subTask = entry["sub-tasks"][sub];
  if (!subTask) return taskFile;
  const nextSubTasks = { ...entry["sub-tasks"], [sub]: { status: "validated" as const, "validated-at": at } };
  return { ...taskFile, [agent]: { files: entry.files, "sub-tasks": nextSubTasks } };
}

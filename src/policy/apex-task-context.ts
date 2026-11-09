import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMaxLines } from "../config/limits";
import { harnessHomeSegment } from "./apex-target";
import { apexTaskSteps } from "./apex-target-steps";

/** Parsed task state injected into a Task sub-agent prompt. */
export interface ApexTaskState {
  /** Current task id (`current_task` from task.json; never defaulted). */
  id: string;
  /** Task subject (defaults to ""). */
  subject: string;
  /** Current phase (defaults to "analyze"). */
  phase: string;
  /** Comma-joined consulted doc keys, or "none". */
  docs: string;
}

/**
 * Read the current task state from `task.json`, reproducing the legacy Python
 * logic. A read/parse error or a file with no `current_task` returns `null`
 * (no real task state — no task id or phase is ever fabricated).
 * @param taskFile - Absolute path to `.claude/apex/task.json`.
 * @returns The parsed {@link ApexTaskState}, or `null` when there is no real current task.
 */
export function loadApexTaskState(taskFile: string): ApexTaskState | null {
  try {
    const data = JSON.parse(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
    if (data.current_task === undefined || data.current_task === null) return null;
    const id = String(data.current_task);
    const tasks = (data.tasks as Record<string, unknown> | undefined) ?? {};
    const task = (tasks[id] as Record<string, unknown> | undefined) ?? {};
    const subject = typeof task.subject === "string" ? task.subject : "";
    const phase = typeof task.phase === "string" ? task.phase : "analyze";
    const consultedMap = (task.doc_consulted as Record<string, unknown> | undefined) ?? {};
    const consulted = Object.entries(consultedMap)
      .filter(([, v]) => typeof v === "object" && v !== null && (v as Record<string, unknown>).consulted === true)
      .map(([k]) => k);
    return { id, subject, phase, docs: consulted.join(", ") || "none" };
  } catch {
    return null;
  }
}

/**
 * Build the APEX context string injected into a Task sub-agent prompt.
 * @param state - The parsed task state, or `null` when there is no real current task (the "Current"/"Docs consulted" lines are then omitted).
 * @param maxLines - SOLID per-file line ceiling.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The injection text.
 */
export function buildApexTaskContext(state: ApexTaskState | null, maxLines: number, id: string = "claude-code"): string {
  const seg = harnessHomeSegment(id);
  const { step3, step4, step7 } = apexTaskSteps(id);
  const current = state
    ? `Current: Task #${state.id} - ${state.subject} (Phase: ${state.phase})\n` + `Docs consulted: ${state.docs}\n\n`
    : "";
  return (
    `⚠️ APEX MODE - Read ${seg}/apex/AGENTS.md for rules\n\n` +
    current +
    `Agent must:\n` +
    `1. Read task.json → find last 3 completed tasks\n` +
    `2. Read their notes in docs/ (task-{ID}-{subject}.md)\n` +
    `3. ${step3}\n` +
    `4. ${step4}\n` +
    `5. Apply SOLID (files < ${maxLines} lines)\n` +
    `6. Write notes to docs/task-{ID}-{subject}.md\n` +
    `7. ${step7}`
  );
}

/**
 * Build the PreToolUse Task injection, gated on the existence of the
 * project's target apex dir (`.claude/apex/`, `.codex/apex/`, ...). Returns
 * `null` when APEX is not active (no dir). With the dir but no readable
 * `task.json` (or no current task), the rules injection is still emitted,
 * just without the "Current"/"Docs consulted" lines.
 * @param projectRoot - `CLAUDE_PROJECT_DIR` or cwd.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The injection text, or `null` to emit nothing.
 */
export function buildApexTaskInjection(projectRoot: string, id: string = "claude-code"): string | null {
  const apexDir = join(projectRoot, harnessHomeSegment(id), "apex");
  if (!existsSync(apexDir)) return null;
  const state = loadApexTaskState(join(apexDir, "task.json"));
  return buildApexTaskContext(state, resolveMaxLines(), id);
}

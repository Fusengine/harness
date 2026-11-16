/** Shared helpers for the order-independent PRD claim tests (prd-claim-order / prd-report-content / test/cli/prd-resume). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeEvent } from "../../../src/runtime/normalize";
import type { NormalizedEvent } from "../../../src/runtime/normalize";
import { prdAgentReportPath, prdTaskPath } from "../../../src/policy/prd";

/** Slot name `i` (1-based) of `type`: the exact name, then `type-2`, `type-3`... */
export const slotName = (type: string, i: number): string => (i === 1 ? type : `${type}-${i}`);

/** Sub-task name of slot `i`. */
export const subName = (i: number): string => `sub-${i}`;

/** `{task: {sub: done}}` report text for the listed sub-tasks. */
export function reportText(task: string, subs: string[]): string {
  return JSON.stringify({ [task]: Object.fromEntries(subs.map((s) => [s, { status: "done", modified: [], unchanged: [] }])) });
}

/** Options of {@link seedSlots}. */
export interface SeedOptions {
  /** Slot indexes (1-based) whose report is COMPLETE on disk. */
  done?: number[];
  /** Slot indexes whose task-PRD entry is compacted (fully validated). */
  compacted?: number[];
  /** Slot indexes whose report is PARTIAL (first of two sub-tasks only). */
  partial?: number[];
}

/**
 * Rewrites the fixture task-PRD `auth-refactor` with `n` slots of `type` (each with one sub-task
 * `sub-<i>`, slot 2 of `partial` with two) and writes the requested on-disk reports.
 */
export function seedSlots(root: string, homeSeg: string, type: string, n: number, opts: SeedOptions = {}): void {
  const file: Record<string, unknown> = {};
  for (let i = 1; i <= n; i++) {
    const subs: Record<string, { status: "assigned" }> = { [subName(i)]: { status: "assigned" } };
    if (opts.partial?.includes(i)) subs[`${subName(i)}-b`] = { status: "assigned" };
    file[slotName(type, i)] = opts.compacted?.includes(i)
      ? { status: "validated", files: [`src/f${i}.ts`], "validated-at": "t" }
      : { files: [`src/f${i}.ts`], "sub-tasks": subs };
  }
  const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put(prdTaskPath(root, homeSeg, "prd/auth-refactor-prd.json"), JSON.stringify(file));
  for (const i of opts.done ?? []) put(prdAgentReportPath(root, homeSeg, slotName(type, i)), reportText("auth-refactor", [subName(i)]));
  for (const i of opts.partial ?? []) put(prdAgentReportPath(root, homeSeg, slotName(type, i)), reportText("auth-refactor", [subName(i)]));
}

/** A claude-code Write event with explicit content and identity. */
export function writeWith(sessionId: string, absPath: string, content: string, agentId?: string, agentType?: string): NormalizedEvent {
  return normalizeEvent("claude-code", {
    hook_event_name: "PreToolUse", tool_name: "Write", session_id: sessionId,
    tool_input: { file_path: absPath, content },
    ...(agentId ? { agent_id: agentId } : {}), ...(agentType ? { agent_type: agentType } : {}),
  });
}

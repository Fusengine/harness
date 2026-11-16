/**
 * @module prd-report-claim
 * The PreToolUse verdict for ONE agent-report write: reads the disk state the
 * pure claim rule needs (is the slot's report already complete?), runs
 * `evaluateWriteOwnership`, then — on a FIRST claim only — refuses content
 * that provably names none of the slot's own sub-tasks (a swapped/foreign
 * report). Content that cannot be derived with certainty is never judged.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  evaluateWriteOwnership, isSlotClosed, readAgentReport, subTasksOf,
  type PrdIdentity, type PrdOwnershipVerdict, type PrdTaskFile,
} from "../../policy/prd";
import type { NormalizedEvent } from "../normalize";
import { canonicalFilePath } from "./prd-canon";
import { derivePostWrite } from "./prd-post-write";

/** Every task-PRD slot merged into one map (first declaration wins) — enough for candidate lookup by name. */
function mergedSlots(taskFiles: Record<string, PrdTaskFile | null>): PrdTaskFile {
  const out: PrdTaskFile = {};
  for (const taskFile of Object.values(taskFiles)) {
    for (const [name, entry] of Object.entries(taskFile ?? {})) if (!Object.hasOwn(out, name)) out[name] = entry;
  }
  return out;
}

/** Current text of `file`, `null` when absent/unreadable. */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `[task, sub]` pairs a report text names; `[]` when it is not a JSON object of objects. */
function reportedPairs(text: string): [string, string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const pairs: [string, string][] = [];
  for (const [task, subs] of Object.entries(parsed)) {
    if (subs === null || typeof subs !== "object" || Array.isArray(subs)) continue;
    for (const sub of Object.keys(subs)) pairs.push([task, sub]);
  }
  return pairs;
}

/** Deny reason when the write's derivable content names sub-tasks, none of them `slot`'s own; else `null`. */
function foreignContentReason(
  slot: string, file: string, event: NormalizedEvent, patch: string, root: string, taskFiles: Record<string, PrdTaskFile | null>,
): string | null {
  const isTarget = (p: string): boolean => canonicalFilePath(resolve(isAbsolute(p) ? p : resolve(root, p))) === file;
  const next = derivePostWrite({ event, patch, isTarget, current: readText(file) });
  if (next.state !== "text") return null;
  const pairs = reportedPairs(next.text);
  if (pairs.length === 0) return null;
  const own = (task: string, sub: string): boolean => {
    const taskFile = taskFiles[task];
    const entry = taskFile && Object.hasOwn(taskFile, slot) ? taskFile[slot] : undefined;
    return entry !== undefined && Object.hasOwn(subTasksOf(entry), sub);
  };
  if (pairs.some(([task, sub]) => own(task, sub))) return null;
  const named = pairs.map(([task, sub]) => `${task}/${sub}`).join(", ");
  return `this report names ${named}, none of which is a sub-task assigned to slot "${slot}" — it looks like another agent's report`;
}

/** Inputs of {@link reportClaimVerdict}. */
export interface ReportClaimInput {
  /** The slot (report name) targeted by the write. */
  agent: string;
  /** Canonical absolute path of the report file. */
  file: string;
  identity: PrdIdentity;
  event: NormalizedEvent;
  /** Raw apply_patch text ("" for other tools). */
  patch: string;
  root: string;
  homeSeg: string;
  /** Every task-PRD of the router, by task name. */
  taskFiles: Record<string, PrdTaskFile | null>;
  /** Current in-memory agentId -> slot bindings. */
  bindings: Record<string, string>;
}

/**
 * Ownership + claim verdict for one agent-report file.
 * @param input - See {@link ReportClaimInput}.
 * @returns The verdict; an `allow` carrying `bind` is a first claim (to be committed by the caller).
 */
export async function reportClaimVerdict(input: ReportClaimInput): Promise<PrdOwnershipVerdict> {
  const { agent, file, identity, event, patch, root, homeSeg, taskFiles, bindings } = input;
  const closed = isSlotClosed(agent, taskFiles, await readAgentReport(root, homeSeg, agent));
  const verdict = evaluateWriteOwnership({ kind: { kind: "agentReport", agent }, identity, taskFile: mergedSlots(taskFiles), bindings, closed });
  if (verdict.allow !== true || !verdict.bind) return verdict;
  const foreign = foreignContentReason(agent, file, event, patch, root, taskFiles);
  return foreign === null ? verdict : { allow: false, reason: foreign };
}

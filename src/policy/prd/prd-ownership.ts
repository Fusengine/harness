/**
 * The PreToolUse ownership decision. Everything it needs is passed in — no
 * I/O. Pure functions over already-loaded router/task-PRD/bindings data.
 */
import { resolveClaim } from "./prd-claim";
import type { PrdIdentity, PrdOwnershipVerdict, PrdPathKind, PrdTaskFile } from "./interfaces/types";

/** True when `name === agentType`, or `"<agentType>-<n>"` with `n >= 2`. */
export function matchesAgentName(name: string, agentType: string): boolean {
  if (name === agentType) return true;
  if (!name.startsWith(agentType)) return false;
  const suffix = name.slice(agentType.length);
  if (!suffix.startsWith("-")) return false;
  const numPart = suffix.slice(1);
  return /^\d+$/.test(numPart) && Number(numPart) >= 2;
}

/** Agent names in `taskFile` whose name matches `agentType` (base or `-n` suffixed). */
export function candidateAgentNames(agentType: string, taskFile: PrdTaskFile): string[] {
  return Object.keys(taskFile).filter((name) => matchesAgentName(name, agentType));
}

const COORDINATOR_ONLY_LABEL: Record<"router" | "task" | "docs", string> = {
  router: "router",
  task: "task PRD",
  docs: "docs",
};

function evaluateCoordinatorOnly(kind: "router" | "task" | "docs", identity: PrdIdentity): PrdOwnershipVerdict {
  if (identity.lead === true) return { allow: true };
  if (identity.lead === "unknown") return { allow: "advisory" };
  return { allow: false, reason: `${COORDINATOR_ONLY_LABEL[kind]} is coordinator-only` };
}

function evaluateAgentReport(
  agent: string,
  identity: PrdIdentity,
  taskFile: PrdTaskFile | null,
  bindings: Record<string, string>,
  closed: boolean,
): PrdOwnershipVerdict {
  if (identity.lead === true) return { allow: false, reason: "agent report is not the coordinator's to write" };
  if (identity.lead === "unknown") return { allow: "advisory" };
  if (identity.agentType === undefined || identity.agentId === undefined) {
    return { allow: false, reason: "unidentifiable agent_type — cannot verify ownership" };
  }
  const candidates = candidateAgentNames(identity.agentType, taskFile ?? {});
  return resolveClaim({ target: agent, agentType: identity.agentType, agentId: identity.agentId, candidates, bindings, closed });
}

/**
 * Top-level PreToolUse verdict for ONE file path already known to be in
 * scope (`classifyPrdPath` returned non-`"other"`/non-`null` upstream).
 */
export function evaluateWriteOwnership(input: {
  kind: PrdPathKind;
  identity: PrdIdentity;
  taskFile: PrdTaskFile | null;
  bindings: Record<string, string>;
  /** True when the target slot's report on disk is already complete (agent-report writes only; default false). */
  closed?: boolean;
}): PrdOwnershipVerdict {
  const { kind, identity, taskFile, bindings } = input;

  if (kind.kind === "router" || kind.kind === "task" || kind.kind === "docs") {
    return evaluateCoordinatorOnly(kind.kind, identity);
  }
  if (kind.kind === "agentReport") {
    return evaluateAgentReport(kind.agent, identity, taskFile, bindings, input.closed === true);
  }
  if (identity.lead === "unknown") return { allow: "advisory" };
  return { allow: false, reason: "not a recognized PRD file" };
}

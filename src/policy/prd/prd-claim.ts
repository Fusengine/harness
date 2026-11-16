/**
 * @module prd-claim
 * Order-independent claim of one agent-report slot. Pure — no I/O. A "slot" is
 * a task-PRD agent key (`<agent_type>`, `<agent_type>-2`, ...). Same-type
 * sub-agents share `agent_type`, so a slot is claimed by WRITING its report,
 * in any order, first-come; the disk (is the slot's report already complete?)
 * decides closed slots, and the per-session track holds the live bindings.
 */
import type { PrdOwnershipVerdict } from "./interfaces/types";

/** Everything {@link resolveClaim} decides on. */
export interface ClaimInput {
  /** The slot (report name) the write targets. */
  target: string;
  /** The writing sub-agent's `agent_type`. */
  agentType: string;
  /** The writing sub-agent's `agent_id`. */
  agentId: string;
  /** Slots declared in the task-PRD(s) for this `agentType` (`candidateAgentNames`). */
  candidates: string[];
  /** Current session's agentId -> slot bindings (read-only). */
  bindings: Record<string, string>;
  /** True when the target slot's report on disk is already complete (`isSlotClosed`). */
  closed: boolean;
}

/**
 * Decide whether `agentId` may write the `target` slot, and whether doing so binds it.
 * 1. `target` must be one of the type's slots; 2. an already-bound agent may only
 * write its own slot; 3. a slot bound to another agent is denied; 4. a slot whose
 * report is already complete is denied to anyone but its (current-session) owner;
 * 5. otherwise allow and bind (one slot per agent).
 * @param input - See {@link ClaimInput}.
 * @returns The verdict; `bind` is set only on a new claim.
 */
export function resolveClaim(input: ClaimInput): PrdOwnershipVerdict {
  const { target, agentType, agentId, candidates, bindings, closed } = input;
  if (!candidates.includes(target)) {
    return { allow: false, reason: `"${target}" is not a slot of your agent_type "${agentType}" (your slots: ${candidates.join(", ") || "none"})` };
  }
  const mine = bindings[agentId];
  if (mine !== undefined) {
    return mine === target
      ? { allow: true }
      : { allow: false, reason: `you already own slot "${mine}" — one slot per agent, "${target}" is not yours to write` };
  }
  if (Object.values(bindings).includes(target)) {
    return { allow: false, reason: `slot "${target}" is already owned by another agent of this session` };
  }
  if (closed) {
    return { allow: false, reason: `slot "${target}" is already reported complete — a new agent cannot rewrite it; claim a slot that is still open` };
  }
  return { allow: true, bind: { agentId, name: target } };
}

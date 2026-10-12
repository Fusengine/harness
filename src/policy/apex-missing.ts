import { apexAuthorizationGate } from "./apex-authorization";
import { brainstormGate, docConsultedGate, freshnessGate, POST_AUTH_GATES, PRE_AUTH_GATES, type ApexContext, type ApexGate } from "./apex";
import type { Prompt } from "../prompt/types";

/** The only gates known NOT to read the lazily loaded refs; any other gate (Check 1, SOLID refs, a future one) is treated as ref-dependent, so it is skipped when the refs are not loaded. */
const REF_FREE: ReadonlySet<ApexGate> = new Set([brainstormGate, freshnessGate, docConsultedGate]);

/** Full gate chain in evaluation order, derived from the exported sub-chains (Check 1 sits between PRE and POST) so a new gate cannot be silently omitted. */
const CHAIN: ReadonlyArray<{ gate: ApexGate; needsRefs: boolean }> = [...PRE_AUTH_GATES, apexAuthorizationGate, ...POST_AUTH_GATES].map((gate) => ({ gate, needsRefs: !REF_FREE.has(gate) }));

/** Compare two prompts by value (gates are deterministic, so the deciding gate re-yields the same prompt). */
const same = (a: Prompt, b: Prompt): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every APEX gate that currently fails EXCEPT the deciding one (`first`), in chain
 * order (brainstorm, freshness, Check 1, Check 2, SOLID refs). Pure: it only calls
 * the gates, never writes state. A gate that throws is omitted, never propagated.
 * @param ctx - The same context the deciding gate saw (`refs` loaded when `refsKnown`).
 * @param first - The prompt that already blocks.
 * @param refsKnown - False when the SOLID refs could not be loaded: the two ref-dependent gates are then skipped.
 * @returns The other failing gates' prompts.
 */
export function otherMissing(ctx: ApexContext, first: Prompt, refsKnown: boolean): Prompt[] {
  const hits: Prompt[] = [];
  for (const { gate, needsRefs } of CHAIN) {
    if (needsRefs && !refsKnown) continue;
    try {
      const hit = gate(ctx);
      if (hit && !same(hit, first)) hits.push(hit);
    } catch {
      // Listing is best-effort: an unevaluable gate is simply not listed.
    }
  }
  return hits;
}

/**
 * Fold the other missing prerequisites into the deciding prompt. The deciding
 * gate's kind/title/ruleId/reason stay as-is; the reason gains one section naming
 * each other gate (title + its actions) and `actions` becomes the first gate's
 * actions then the others', deduplicated, order preserved. No others → `first`
 * itself (byte-identical).
 * @param first - The prompt of the first failing gate.
 * @param others - The prompts of the other failing gates.
 * @returns The merged prompt.
 */
export function mergeMissing(first: Prompt, others: Prompt[]): Prompt {
  if (others.length === 0) return first;
  const section = others.map((o) => [`- ${o.title}`, ...(o.actions ?? []).map((a) => `    ${a}`)].join("\n"));
  const reason = [first.reason, "", `Also missing (${others.length} more):`, ...section].join("\n");
  const actions = [...new Set([...(first.actions ?? []), ...others.flatMap((o) => o.actions ?? [])])];
  return { ...first, reason, actions: actions.length ? actions : first.actions };
}

/**
 * Block-path helper: `first` plus every other failing APEX prerequisite. Never
 * throws and never writes state — on any failure it returns `first` unchanged.
 * @param first - The prompt of the first failing gate.
 * @param ctx - The context the gates ran on.
 * @param refsKnown - False when the SOLID refs could not be loaded (see {@link otherMissing}).
 * @returns The merged prompt, or `first` unchanged when nothing else fails or listing errors.
 */
export function listAllMissing(first: Prompt, ctx: ApexContext, refsKnown: boolean): Prompt {
  try {
    return mergeMissing(first, otherMissing(ctx, first, refsKnown));
  } catch {
    return first;
  }
}

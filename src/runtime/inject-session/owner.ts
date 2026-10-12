/**
 * @module inject-session/owner
 * Loader-owner mode: a scope that no ENABLED plugin runs natively
 * ({@link module:inject-session/ownership}) reaches the model only through the
 * hooks-loader, which concatenates every child's output into ONE field (cap
 * 10 000, else a 2 000-char preview). Its loader copy therefore acts as the
 * owner — recall, registry, chunked delivery — but all owners share one
 * 9 500-char budget so the merged field never spills:
 *   - UserPromptSubmit: each owner always shows the 2 000-char head of its block
 *     (what HEAD's preview showed), plus an `extra` slice of undelivered chunks;
 *   - SessionStart / SubagentStart / PostToolUse: one `share` of chunks per owner.
 * A reserve is left for children outside the registry (non-owner prints).
 */
import { deliverNext } from "./deliver";
import { claimRecall, dedupeUnits, promptIdOf, trimOverlap } from "./recall";
import { openScope } from "./registry";
import { hasParked } from "./units";
import { stripNativeDoc } from "./native-doc";
import { contextOf, withContext } from "./envelope";
import type { FilterInput } from "./filter";

/** Size of the always-shown head of an owner's block per prompt (HEAD's preview). */
const HEAD_CHARS = 2000;
/** One field's budget for ALL loader owners together (below the 10 000 spill). */
const TOTAL = 9500;
/** Left for loader children that are not owners (printed as HEAD printed them). */
const RESERVE = 1500;

/**
 * Per-owner budgets for `owners` loader-only scopes sharing one merged field.
 * @param owners - Number of loader-only scopes for the event.
 * @returns `extra`: chunk chars per prompt on top of the head (0 when too small to be useful); `share`: chunk chars per event without a head.
 */
export function ownerBudget(owners: number, held: number = 0): { extra: number; share: number; unit: number } {
  const n = Math.max(1, owners);
  const e = Math.floor((TOTAL - RESERVE - n * HEAD_CHARS) / n);
  const extra = e >= 600 ? e : 0;
  const share = Math.max(1000, Math.floor((TOTAL - RESERVE - held) / n));
  // ONE segmentation ceiling for every owner event: a chunk parked at SessionStart must also fit the (smaller) per-prompt slice.
  return { extra, share, unit: extra > 0 ? extra : share };
}

/** UserPromptSubmit as owner: head every prompt + a bounded slice of the not-yet-delivered rest. */
export function ownerPrompt(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput, owners: number): string {
  const original = contextOf(obj);
  if (!original) return stdout;
  const scope = openScope(input.stateDir, name);
  const text = dedupeUnits(original);
  if (!claimRecall(scope, text, promptIdOf(input.payload))) return withContext(obj, event, "");
  const { extra, unit } = ownerBudget(owners);
  const head = original.slice(0, HEAD_CHARS);
  const rest = extra > 0 ? deliverNext(scope, stripNativeDoc(text, input.home), input.now, `${input.scope}:${event}`, extra, unit) : "";
  return withContext(obj, event, trimOverlap(head, rest));
}

/** SessionStart / SubagentStart as owner: one share of chunks (the first unit starts at the block's start, so it covers HEAD's head). */
export function ownerStart(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput, owners: number): string {
  const reset = event === "SessionStart" ? { source: String(input.payload.source ?? "startup"), scope: input.scope } : undefined;
  const scope = openScope(input.stateDir, name, reset);
  const original = contextOf(obj);
  // At SubagentStart native-backed loader children may print together at most HEAD's 2 000-char preview (see native-head): keep room for it.
  const { share, unit } = ownerBudget(owners, event === "SubagentStart" ? HEAD_CHARS : 0);
  const kept = deliverNext(scope, stripNativeDoc(original, input.home), input.now, `${input.scope}:${event}`, share, unit);
  return kept === original ? stdout : withContext(obj, event, kept);
}

/** PostToolUse as owner: drain one share of parked chunks. */
export function ownerDrain(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput, owners: number): string {
  if (!hasParked(input.stateDir, name)) return stdout;
  const { share, unit } = ownerBudget(owners);
  const kept = deliverNext(openScope(input.stateDir, name), "", input.now, "", share, unit);
  if (!kept) return stdout;
  const own = contextOf(obj);
  return withContext(obj, event, own ? `${own}\n\n${kept}` : kept);
}

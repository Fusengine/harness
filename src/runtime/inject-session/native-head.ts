/**
 * @module inject-session/native-head
 * The loader copy of a scope that DOES have a native copy is silent — except for the part of its
 * block that sat inside the 2 000-char preview of 0.1.107's merged loader field. If the native copy
 * failed (crash, timeout, empty output) the model would lose exactly that part, so the loader child
 * prints it. Where that part lies is computable: the loader merges its children in a fixed order
 * ({@link module:inject-session/ownership.loaderOrder}), so a block's offset in the merged field is
 * the sum of the ORIGINAL lengths of the blocks before it. Every hook process of the recipient
 * records its original length for the event (a tiny ledger file), and the child waits briefly for
 * the missing ones of its predecessors. At UserPromptSubmit and SessionStart the owner's block sits
 * beyond the preview (core precedes it), so nothing is owed there.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claim, known } from "./units";
import { openScope, unitHash, type Scope } from "./registry";
import { segment } from "./segment";
import { stripNativeDoc } from "./native-doc";
import { contextOf, withContext } from "./envelope";
import { PREVIEW_CHARS } from "./recall";
import type { FilterInput } from "./filter";

/** Ledger file of one plugin scope's original block length at an event: `<epoch>.o.<event>.<scope>`. */
function lenFile(s: Scope, event: string, who: string): string {
  return join(s.root, `${s.epoch}.o.${event}.${who.replace(/[^\w-]/g, "_")}`);
}

/**
 * Record how long this scope's block was before any filtering (idempotent: native and loader copies print the same block).
 * @param s - Open registry scope of the recipient.
 * @param event - Hook event name.
 * @param who - Plugin scope of the calling process.
 * @param len - Length of its original additionalContext (0 when empty).
 */
export function recordOriginal(s: Scope, event: string, who: string, len: number): void {
  try { writeFileSync(lenFile(s, event, who), String(len)); } catch { /* ledger is best effort: a missing entry counts as 0 */ }
}

/** Block until `ms` elapsed (synchronous: a hook process has nothing else to do). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Chars the scopes BEFORE `who` in the loader's merge order put in front of its block in 0.1.107's merged field.
 * @param s - Open registry scope of the recipient.
 * @param event - Hook event name.
 * @param who - Plugin scope of the calling process.
 * @param order - The loader's merge order of scopes for the event.
 * @param waitMs - How long to wait for predecessors that have not recorded yet (they count 0 afterwards).
 * @returns The offset, or null when `who` is not in `order` (order unknown).
 */
export function precedingLength(s: Scope, event: string, who: string, order: string[], waitMs: number): number | null {
  const at = order.indexOf(who);
  if (at < 0) return null;
  const before = order.slice(0, at);
  const read = (w: string): number | undefined => {
    try { return Number(readFileSync(lenFile(s, event, w), "utf-8")); } catch { return undefined; }
  };
  const deadline = Date.now() + waitMs;
  let lens = before.map(read);
  while (lens.some((l) => l === undefined) && Date.now() < deadline) {
    sleep(10);
    lens = before.map(read);
  }
  return lens.reduce<number>((n, l) => n + (l ? l + 2 : 0), 0);
}

/**
 * Output of the loader copy of a scope that has a native copy.
 * @param stdout - The child's raw stdout.
 * @param obj - Parsed envelope.
 * @param event - Hook event name.
 * @param name - Registry scope name of the recipient.
 * @param input - Filter input (state dir, home, plugin scope, loader order, wait).
 * @returns Only the part of its block HEAD's merged preview showed (SubagentStart), unless the native copy already delivered it; otherwise "".
 */
export function nativeHead(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput): string {
  const original = contextOf(obj);
  const silent = withContext(obj, event, "");
  if (event !== "SubagentStart" || !original) return silent;
  const scope = openScope(input.stateDir, name);
  const first = segment(stripNativeDoc(original, input.home))[0];
  if (first !== undefined && known(scope, unitHash(first))) return silent;
  const agentType = typeof input.payload.agent_type === "string" ? input.payload.agent_type : "";
  const before = precedingLength(scope, event, input.scope, input.order?.(event, agentType) ?? [], input.settleMs ?? 0);
  if (before === null) {
    // Merge order unknown: one head slot per recipient keeps the merged field bounded.
    return claim(scope, unitHash(`native-head:${event}`)) ? withContext(obj, event, original.slice(0, PREVIEW_CHARS)) : silent;
  }
  return PREVIEW_CHARS - before > 0 ? withContext(obj, event, original.slice(0, PREVIEW_CHARS - before)) : silent;
}

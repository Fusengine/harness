/**
 * @module inject-session/recall
 * Per-prompt RECALL for Claude Code UserPromptSubmit. The owner built the
 * per-prompt injection because the model forgets: every prompt must still show
 * at least what HEAD showed — the inline block as is, or, for a block above
 * Claude Code's 10 000-char cap (which keeps only a file path plus the first
 * 2 000 characters), that 2 000-char head. Only TRUE duplicates are removed:
 * an identical paragraph twice in one block, and the same block emitted by two
 * hook processes for the same prompt (e.g. the hooks-loader double run).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { segment } from "./segment";
import { unitHash, type Scope } from "./registry";

/** Claude Code spills an `additionalContext` longer than this. */
export const SPILL_AT = 10_000;
/** Length of the preview Claude Code keeps of a spilled value (exact prefix, no newline cut documented). */
export const PREVIEW_CHARS = 2000;

/**
 * What the model saw of `text` in HEAD: all of it when inline, else the preview prefix.
 * @param text - A hook's additionalContext.
 * @returns The visible part.
 */
export function visibleHead(text: string): string {
  return text.length > SPILL_AT ? text.slice(0, PREVIEW_CHARS) : text;
}

/**
 * Remove repeated identical units (paragraph groups) inside one block, keeping the first.
 * @param text - A hook's additionalContext.
 * @returns `text` unchanged when it has no repeated unit.
 */
export function dedupeUnits(text: string): string {
  const units = segment(text);
  const seen = new Set<string>();
  const unique = units.filter((u) => { const h = unitHash(u); if (seen.has(h)) return false; seen.add(h); return true; });
  return unique.length === units.length ? text : unique.join("\n\n");
}

/**
 * Append `rest` (undelivered chunks of the SAME block) to the recalled `head` without repeating
 * what `head` already shows. `rest` starts at a unit boundary of the block, so its start may lie
 * inside `head`: the overlapping part is cut off (a chunk wholly inside the head vanishes, one
 * straddling its end continues it exactly where it was cut). A `rest` that does not start inside
 * the head is joined as a new paragraph.
 * @param head - The always-shown head (an exact prefix of the block).
 * @param rest - Chunks emitted by the registry for this prompt ("" when none).
 * @returns The field to print: `head` plus only the new part of `rest`.
 */
export function trimOverlap(head: string, rest: string): string {
  if (!rest) return head;  const probe = rest.slice(0, 80);
  for (let at = head.indexOf(probe); at >= 0; at = head.indexOf(probe, at + 1)) {
    const tail = head.slice(at);
    if (rest.startsWith(tail)) return head + rest.slice(tail.length);
    if (tail.startsWith(rest)) return head;
  }
  return `${head}\n\n${rest}`;
}

/** Record file of a recalled block: `<epoch>.r.<hash of the block>`, content = the `prompt_id` it was recalled for. */
function recallFile(scope: Scope, text: string): string {
  return join(scope.root, `${scope.epoch}.r.${unitHash(text)}`);
}

/**
 * The documented `prompt_id` (UUID of the prompt being processed) of a hook payload.
 * @param payload - Raw hook payload.
 * @returns The id, or undefined when absent (then nothing is ever suppressed, like HEAD).
 */
export function promptIdOf(payload: Record<string, unknown>): string | undefined {
  const id = payload.prompt_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Claim the right to emit this recall for this prompt: false only when another
 * hook process already recalled the SAME block for the SAME `prompt_id`. Without
 * a `prompt_id` there is no safe notion of "same prompt": always emit.
 * @param scope - Open registry scope.
 * @param text - The block about to be recalled.
 * @param promptId - {@link promptIdOf} of the payload.
 * @returns True to emit.
 */
export function claimRecall(scope: Scope, text: string, promptId: string | undefined): boolean {
  if (promptId === undefined) return true;
  if (recalledFor(scope, text, promptId)) return false;
  writeFileSync(recallFile(scope, text), promptId);
  return true;
}

/**
 * Did the native copy already recall this block for this `prompt_id`? (read-only; the loader copy's drop condition)
 * @param scope - Registry scope.
 * @param text - The block (as the loader copy would print it).
 * @param promptId - {@link promptIdOf} of the payload.
 * @returns True only for an exact prompt_id match.
 */
export function recalledFor(scope: Scope, text: string, promptId: string | undefined): boolean {
  if (promptId === undefined) return false;
  try { return readFileSync(recallFile(scope, text), "utf-8") === promptId; } catch { return false; }
}

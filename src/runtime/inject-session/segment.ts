/**
 * @module inject-session/segment
 * Deterministic split of an injected context block into delivery units. A unit
 * is the atom of the per-session registry (hashed, delivered once) and of the
 * chunked first delivery: every unit is strictly smaller than the Claude Code
 * `additionalContext` cap, and boundaries fall on blank lines (or line breaks
 * for an oversized paragraph) so order and content are preserved.
 */

/** Max chars of one unit — under Claude Code's 10 000-char `additionalContext` cap (beyond it the model sees a ~2 KB preview). */
export const UNIT_MAX = 9500;

/**
 * Default unit ceiling. Below {@link UNIT_MAX} so that a unit always fits next to the per-prompt
 * recall (a 2 000-char head) inside one 9 500-char envelope: a parked unit can never be starved.
 */
export const UNIT_SEG_MAX = 7000;

/** Soft minimum: consecutive paragraphs are grouped until a unit reaches this size, so tiny paragraphs are not hashed one by one. */
export const UNIT_MIN = 1200;

/** Split one over-long unit on line breaks into pieces of at most `max` chars (a single over-long line is sliced). */
function splitOnLines(unit: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of unit.split("\n")) {
    const next = cur === "" ? line : `${cur}\n${line}`;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur !== "") out.push(cur);
    let rest = line;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    cur = rest;
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Split `text` into ordered delivery units. Paragraphs (blank-line separated)
 * are grouped up to `min` chars and never past `max`; a paragraph longer than
 * `max` is cut on line breaks. Joining the units with a blank line restores the
 * text (up to the cosmetic newline of an oversized-paragraph cut).
 * @param text - The block to split.
 * @param max - Hard ceiling per unit (default {@link UNIT_SEG_MAX}).
 * @param min - Soft grouping minimum (default {@link UNIT_MIN}).
 * @returns The non-empty units, in order ([] for blank input).
 */
export function segment(text: string, max: number = UNIT_SEG_MAX, min: number = UNIT_MIN): string[] {
  if (text.trim() === "") return [];
  const grouped: string[] = [];
  let cur: string | null = null;
  for (const para of text.split("\n\n")) {
    if (cur === null) cur = para;
    else if (cur.length >= min || cur.length + 2 + para.length > max) {
      grouped.push(cur);
      cur = para;
    } else cur = `${cur}\n\n${para}`;
  }
  if (cur !== null) grouped.push(cur);
  return grouped.flatMap((u) => (u.length > max ? splitOnLines(u, max) : [u])).filter((u) => u.trim() !== "");
}

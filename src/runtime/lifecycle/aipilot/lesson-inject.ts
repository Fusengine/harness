/**
 * Stage 2 — compress the LESSON.md SessionStart/SubagentStart block (the big
 * token win). The RECENT_FULL newest bullets pass verbatim; every older bullet
 * collapses to ONE line — its date plus the FIRST SENTENCE of the actionable
 * rule after the bullet's LAST "→" (the file's `narrative → rule` format), or of
 * the whole bullet when there is no arrow, hard-capped at RULE_CAP chars. The
 * FILE keeps full bullets (human source of truth); only this injected view is
 * compressed, so compression applies even under the cap.
 */
import { splitInlineTag } from "../../../policy/lessons/trigger-tag";
import { type Block, parse } from "./lesson-parse";

/**
 * Newest bullets kept verbatim. Rationale: the most recent lessons are the ones
 * still tied to live work and worth full narrative context. Real bullets run
 * 0.5–1.5 kB each, so 10 (not 15) verbatim clears the >70% shrink target on the
 * live file while still preserving the actively-relevant recent set whole.
 */
export const RECENT_FULL = 10;

/** Max chars of a distilled rule — keeps every compressed bullet to one line. */
export const RULE_CAP = 200;

/**
 * Min readable length of a distilled rule. The old "text after the LAST →" rule
 * produced illegible stubs when a bullet ended on a short trailing arrow segment
 * (e.g. `- [2026-07-02 00:02] lecture).`, 30 chars). Below this we fall back to
 * the whole rule's first sentence rather than ship a meaningless fragment.
 */
export const MIN_RULE = 40;

/** The `[YYYY-MM-DD HH:MM]` (or date-only) stamp of a bullet, "" if absent. */
function stamp(block: Block): string {
  const m = (block.raw[0] ?? "").match(/\[(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\]/);
  return m?.[1] ?? "";
}

/** Bullet text: raw lines joined, leading "- ", date stamp & TRIGGERS lines stripped. */
function bodyText(block: Block): string {
  const kept = block.raw.filter((l) => !/^\s*\[TRIGGERS\s/.test(l));
  const joined = kept.join(" ");
  // An own-line tag takes precedence (byte-identical to before); only an untagged-by-line block loses its inline tag.
  const text = kept.length === block.raw.length ? (splitInlineTag(joined)?.text ?? joined) : joined;
  return text.replace(/^-\s*/, "").replace(/\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "").trim();
}

/** First sentence of `s` (split on a period + whitespace), whole string if none. */
function firstSentence(s: string): string {
  return (s.split(/(?<=\.)\s/)[0] ?? s).trim();
}

/**
 * The bullet's `narrative → rule` delimiter: a SPACED arrow only. A GLUED arrow
 * between tokens (e.g. `120s→300s`, `s→3`) is prose the author wrote, never a
 * delimiter — matching on `→` alone chopped rules mid-token (bug: `300s) pensant
 * corriger…`). Also used to split rule-internal clauses.
 */
const RULE_ARROW = /\s+→\s+/;

/**
 * Distil the actionable rule from a bullet body. With no spaced arrow the whole
 * bullet is the rule → its first sentence. Otherwise the rule is everything after
 * the FIRST spaced arrow; its spaced-arrow-delimited segments are kept whole
 * except for TRAILING short asides (< {@link MIN_RULE} chars, e.g. `→ (cf.
 * lecture).`) which are dropped — so an arrow used as PROSE inside a rule (`maps
 * X → Y doit…`) is preserved intact rather than chopped at the arrow. When the
 * kept rule is still under {@link MIN_RULE} chars, fall back to the first sentence
 * of the WHOLE rule part (never the narrative), avoiding an illegible stub.
 */
function distillRule(text: string): string {
  const sep = text.search(RULE_ARROW);
  if (sep < 0) return firstSentence(text);
  const rulePart = text.slice(sep).replace(RULE_ARROW, "").trim();
  const segments = rulePart.split(RULE_ARROW).map((s) => s.trim()).filter(Boolean);
  while (segments.length > 1 && (segments[segments.length - 1]?.length ?? 0) < MIN_RULE) segments.pop();
  const rule = firstSentence(segments.join(" → "));
  return rule.length >= MIN_RULE ? rule : firstSentence(rulePart);
}

/** Collapse one older bullet to `- [date] <rule>`: {@link distillRule}, capped. */
function compressBullet(block: Block): string {
  let rule = distillRule(bodyText(block));
  if (rule.length > RULE_CAP) rule = `${rule.slice(0, RULE_CAP - 1).trimEnd()}…`;
  const date = stamp(block);
  return `- ${date ? `[${date}] ` : ""}${rule}`;
}

/**
 * Build the compressed injection body for `content`. The preamble comments are
 * dropped (format docs, noise for the reader); the `recentFull` newest bullets
 * stay whole, every older bullet becomes one distilled rule-line.
 * @param content - Raw LESSON.md text.
 * @param recentFull - Count of newest bullets to keep verbatim.
 * @returns The compressed block (bullets only), or the trimmed content when there are no bullets.
 */
export function compressInjection(content: string, recentFull: number = RECENT_FULL): string {
  const entries = lessonEntries(content, recentFull);
  if (entries.length === 0) return content.trim();
  return entries.map((e) => (e.recent ? e.whole : e.compact)).join("\n");
}

/** One bullet in injection order: its whole text, its one-line distillation, and whether it is among the newest. */
export interface LessonEntry { whole: string; compact: string; recent: boolean; }

/**
 * Blocks ordered NEWEST FIRST by their `[YYYY-MM-DD HH:MM]` stamp. Real files are
 * hybrid (newest-first head, newest appended at the end), so file order is not
 * age order. Stable: equal stamps keep file order; blocks with no/invalid stamp
 * sort after every dated one, in file order.
 */
function byNewest(blocks: Block[]): Block[] {
  const key = (b: Block): number => (Number.isNaN(b.ts) ? Number.NEGATIVE_INFINITY : b.ts);
  return blocks.map((b, i) => ({ b, i })).sort((x, y) => key(y.b) - key(x.b) || x.i - y.i).map((e) => e.b);
}

/**
 * Per-bullet injection entries, newest first (see {@link byNewest}); the first
 * `recentFull` are flagged `recent` (kept whole), the rest are compressed.
 * @param content - Raw LESSON.md text.
 * @param recentFull - Count of newest bullets kept whole.
 * @returns The ordered entries (empty when the content has no bullets).
 */
export function lessonEntries(content: string, recentFull: number = RECENT_FULL): LessonEntry[] {
  return byNewest(parse(content).blocks).map((b, i) => ({
    whole: b.raw.join("\n"), compact: compressBullet(b), recent: i < recentFull,
  }));
}

/**
 * Fit the injected LESSON.md view to the fragment budget by WHOLE bullets, newest
 * kept whole. A blind tail cut (capFragment) assumed file order = age order and
 * chopped whatever sat last — with hybrid files that is the newest lessons.
 * Here, when over budget, the OLDEST entries go first: compressed lines are
 * dropped oldest-first, then the oldest whole bullets are demoted to their
 * one-line rule. No bullet is ever cut mid-way. Confined to the lessons path.
 */
import { lessonEntries, RECENT_FULL } from "../aipilot/lesson-inject";
import { FRAGMENT_CHAR_CAP } from "../../inject-budget";

/** Truncation notice — same wording as capFragment's, so the reader sees the same semantics. */
function notice(kept: number, total: number): string {
  return `\n[truncated lessons: kept ${kept} of ${total} chars — source file unchanged]`;
}

/**
 * Build the injected lessons body, newest first, within `cap` characters.
 * Under budget it equals `compressInjection(content)`; over budget it sheds the
 * oldest whole bullets and appends the truncation notice (total ≤ `cap`).
 * @param content - Raw LESSON.md text.
 * @param cap - Max output chars (defaults to the fragment ceiling).
 * @param recentFull - Count of newest bullets kept whole before fitting.
 * @returns The fitted body, or the trimmed content when it has no bullets.
 */
export function fitLessons(content: string, cap: number = FRAGMENT_CHAR_CAP, recentFull: number = RECENT_FULL): string {
  const entries = lessonEntries(content, recentFull);
  if (entries.length === 0) return content.trim();
  const items = entries.map((e) => ({ text: e.recent ? e.whole : e.compact, compact: e.compact, whole: e.recent }));
  const render = (): string => items.map((i) => i.text).join("\n");
  const total = render().length;
  if (total <= cap) return render();
  const budget = Math.max(0, cap - notice(total, total).length);
  while (render().length > budget && items.length > 1) {
    let last = items.length - 1;
    while (last > 0 && items[last]?.whole) last--;
    const target = items[last];
    if (target && !target.whole) items.splice(last, 1); // drop the oldest compressed line
    else { // only whole bullets left: demote the oldest to its rule line
      const oldest = items[items.length - 1];
      if (oldest) { oldest.text = oldest.compact; oldest.whole = false; }
    }
  }
  const body = render();
  return body + notice(body.length, total);
}

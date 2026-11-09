/**
 * LESSON.md injection order + budget fit (item A5): real files are HYBRID
 * (newest-first head, newest appended at the end), so the injected view must sort
 * blocks by their `[YYYY-MM-DD HH:MM]` stamp (newest first; stable for equal or
 * missing stamps), keep the newest whole, and fit the lessons fragment to the
 * budget by dropping/compressing WHOLE bullets — never a mid-bullet cut.
 */
import { test, expect } from "bun:test";
import { compressInjection, RECENT_FULL } from "../src/runtime/lifecycle/aipilot/lesson-inject";
import { fitLessons } from "../src/runtime/lifecycle/lessons/fit-lessons";
import { FRAGMENT_CHAR_CAP } from "../src/runtime/inject-budget";

/** One bullet with a stamp, a long narrative, and a `→ rule`. */
function bullet(ts: string, tag: string, narrative = 700): string {
  return `- [${ts}] narrative ${tag} ${"verbeux ".repeat(Math.ceil(narrative / 8))}→ regle actionnable ${tag} a respecter toujours sans exception.`;
}

/** Hybrid file: newest-first head, then the genuinely newest appended at the END. */
function hybrid(): { text: string; lines: string[] } {
  const head = Array.from({ length: 14 }, (_v, i) => bullet(`2026-10-${String(20 - i).padStart(2, "0")} 10:00`, `HEAD${i}`));
  const tail = [bullet("2026-11-05 08:30", "NEWEST"), bullet("2026-11-04 09:00", "NEWER")];
  const lines = [...head, ...tail];
  return { text: `# LESSON.md\n<!-- doc -->\n\n${lines.join("\n\n")}\n`, lines };
}

test("compressInjection: sorts by stamp newest first — a bullet appended at the END comes first and whole", () => {
  const { text } = hybrid();
  const out = compressInjection(text).split("\n");
  expect(out[0]).toContain("narrative NEWEST");
  expect(out[1]).toContain("narrative NEWER");
});

test("compressInjection: stable for equal stamps, missing stamp sorts after dated ones in original order", () => {
  const input = [
    "- [2026-10-01 10:00] first-equal",
    "- no stamp one",
    "- [2026-10-01 10:00] second-equal",
    "- no stamp two",
    "- [2026-10-02 10:00] newest-dated",
  ].join("\n");
  const out = compressInjection(input, 99).split("\n").map((l) => l.replace(/^- (\[[^\]]+\] )?/, ""));
  expect(out).toEqual(["newest-dated", "first-equal", "second-equal", "no stamp one", "no stamp two"]);
});

test("compressInjection: newest-first input keeps its order (no behaviour change for sorted files)", () => {
  const input = Array.from({ length: RECENT_FULL + 3 }, (_v, i) => `- [2026-06-${String(20 - i).padStart(2, "0")} 09:00] item${i}`).join("\n");
  const firsts = compressInjection(input).split("\n").map((l) => l.match(/item(\d+)/)?.[1]);
  expect(firsts).toEqual(Array.from({ length: RECENT_FULL + 3 }, (_v, i) => String(i)));
});

test("fitLessons: hybrid file -> newest whole, output <= budget, only whole bullets, notice kept", () => {
  const { text, lines } = hybrid();
  expect(compressInjection(text).length).toBeGreaterThan(FRAGMENT_CHAR_CAP); // premise: needs fitting
  const out = fitLessons(text);
  expect(out.length).toBeLessThanOrEqual(FRAGMENT_CHAR_CAP);
  const outLines = out.split("\n");
  expect(outLines[0]).toBe(lines[14]); // the newest bullet, byte-identical (whole)
  const notice = outLines.at(-1) ?? "";
  expect(notice).toMatch(/^\[truncated lessons: kept \d+ of \d+ chars — source file unchanged\]$/);
  for (const l of outLines.slice(0, -1)) {
    const whole = lines.includes(l);
    const compact = /^- \[[^\]]+\] .+[^…]$/.test(l) && !l.includes("narrative");
    expect(whole || compact).toBe(true); // never a bullet chopped mid-way
  }
  expect(out).not.toContain("HEAD13"); // the oldest is what got dropped, not the newest
});

test("fitLessons: content already under the budget is returned like compressInjection (no notice)", () => {
  const input = "- [2026-10-01 10:00] a → regle courte a garder toujours ici.\n- [2026-10-02 10:00] b → autre regle courte a garder toujours.";
  const out = fitLessons(input);
  expect(out).toBe(compressInjection(input));
  expect(out).not.toContain("[truncated");
});

test("fitLessons: honours a custom budget and always stays within it", () => {
  const { text } = hybrid();
  for (const cap of [3000, 5000, 6500]) {
    const out = fitLessons(text, cap);
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out.split("\n")[0]).toContain("narrative NEWEST");
  }
});

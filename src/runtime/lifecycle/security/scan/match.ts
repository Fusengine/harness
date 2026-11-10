/**
 * @module security/scan/match
 * Per-line rule matching. Legacy rules see the full line and are never
 * suppressed; new rules see the line truncated to `maxLineChars` and are
 * deduplicated per line by CWE (an earlier finding with the same CWE wins).
 * @packageDocumentation
 */
import type { ScanPattern } from "./types";

/** One rule match on a 1-based line. */
export interface Hit { pattern: ScanPattern; line: number }

/**
 * Scan `text` with `patterns`.
 * @param text - file content
 * @param patterns - ordered rules (legacy first)
 * @param maxLineChars - truncation length for non-legacy rules
 * @returns hits in line order, plus the count of lines that were truncated
 */
export function scanText(text: string, patterns: readonly ScanPattern[], maxLineChars: number): { hits: Hit[]; longLines: number } {
  const hits: Hit[] = [];
  const gates = new Map<ScanPattern, boolean>();
  let longLines = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "") continue;
    const clipped = line.length > maxLineChars ? line.slice(0, maxLineChars) : line;
    if (clipped !== line) longLines++;
    let seen: Set<string> | undefined;
    for (const p of patterns) {
      if (!p.regex.test(p.legacy ? line : clipped)) continue;
      if (p.gate) {
        let ok = gates.get(p);
        if (ok === undefined) { ok = p.gate.test(text); gates.set(p, ok); }
        if (!ok) continue;
      }
      if (!p.legacy && seen?.has(p.cwe)) continue;
      (seen ??= new Set()).add(p.cwe);
      hits.push({ pattern: p, line: i + 1 });
    }
  }
  return { hits, longLines };
}

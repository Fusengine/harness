/**
 * @module test/scan/legacy-scan
 * FROZEN verbatim copy of the pre-coverage scanner (main 6c1041f), only the
 * import path and export names differ. Test-only regression baseline.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { getPatterns, type ScanPattern, type Severity } from "./legacy-patterns";

const EXCLUDE_RE = /(^|\/)(node_modules|vendor|\.git|dist|build)(\/|$)/;
const LANG_FILES: readonly (readonly [string, string])[] = [
  ["package.json", "javascript"], ["composer.json", "php"], ["requirements.txt", "python"],
  ["pyproject.toml", "python"], ["Package.swift", "swift"], ["go.mod", "go"], ["Cargo.toml", "rust"],
];

/** A single vulnerability match in the scanned tree. */
export interface LegacyFinding {
  severity: Severity; category: string; pattern: string; file: string; line: number;
}

/** The legacy scan report. */
export interface LegacyReport {
  language: string; directory: string;
  summary: Record<string, number>; findings: LegacyFinding[];
}

/** Detect the project language from its config files (first match wins). */
export function legacyDetectLanguage(dir: string): string {
  for (const [file, lang] of LANG_FILES) if (existsSync(join(dir, file))) return lang;
  return "unknown";
}

function collectFiles(dir: string, ext: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (EXCLUDE_RE.test(full)) continue;
    if (e.isDirectory()) collectFiles(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function scanPattern(dir: string, p: ScanPattern): LegacyFinding[] {
  const ext = p.glob.replace(/^\*/, "");
  const findings: LegacyFinding[] = [];
  for (const file of collectFiles(dir, ext)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      if (p.regex.test(line)) findings.push({ severity: p.severity, category: p.category, pattern: p.regex.source, file, line: i + 1 });
    });
  }
  return findings;
}

/** Run the legacy OWASP scan over `dir`. */
export function legacyScan(dir: string): LegacyReport {
  const language = legacyDetectLanguage(dir);
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: LegacyFinding[] = [];
  for (const p of getPatterns(language)) {
    const hits = scanPattern(dir, p);
    findings.push(...hits);
    const key = p.severity.toLowerCase();
    counts[key] = (counts[key] ?? 0) + hits.length;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { language, directory: dir, summary: { ...counts, total }, findings };
}

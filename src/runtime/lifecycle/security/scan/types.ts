/**
 * @module security/scan/types
 * Shared types of the wide-coverage OWASP scanner.
 * @packageDocumentation
 */

/** Vulnerability severity level (drives the summary counters). */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** A single scan rule: one regex applied per line, one severity. */
export interface ScanPattern {
  /** Stable unique id (`<lang>.<class>.<name>`). */
  id: string;
  severity: Severity;
  category: string;
  /** Single-line semantics: no `g`/`y` flag, no `^`/`$`/lookbehind-at-start. */
  regex: RegExp;
  cwe: string;
  /** OWASP Top 10:2025 label (omitted when not verified). */
  owasp?: string;
  /** Byte-identical to the pre-coverage scanner; never suppressed by dedupe. */
  legacy?: true;
  /** Whole-file precondition (the rule only runs when the file also matches). */
  gate?: RegExp;
}

/** A single vulnerability match. The first five keys are the legacy contract. */
export interface Finding {
  severity: Severity; category: string; pattern: string; file: string; line: number;
  id: string; cwe: string; owasp?: string; language: string;
}

/** Size/shape limits (env-tunable); they never apply to legacy-read files. */
export interface ScanLimits {
  maxFileBytes: number; maxLineChars: number; maxFiles: number; maxTotalBytes: number;
}

/** Skip counters by reason. */
export interface SkippedCounts {
  excludedDirs: number; binary: number; minified: number; oversize: number; unreadable: number;
  lockfiles: number; generated: number; longLines: number; capped: boolean;
}

/** What the scan actually covered (appended as the last report key). */
export interface Coverage {
  patternSetVersion: string;
  primaryLanguage: string;
  languages: string[];
  filesScanned: Record<string, number>;
  patternsApplied: Record<string, number>;
  totals: { files: number; bytes: number };
  projects: { root: string; marker: string }[];
  skipped: SkippedCounts;
  unsupported: Record<string, number>;
  limits: ScanLimits;
}

/** The full scan report (legacy keys first, `coverage` appended). */
export interface ScanReport {
  language: string; directory: string;
  summary: Record<string, number>; findings: Finding[]; coverage: Coverage;
}

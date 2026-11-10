/**
 * @module security/scan/patterns/define
 * Rule factories and the CWE -> OWASP Top 10:2025 label map.
 * The map was checked against the per-category CWE lists on
 * https://owasp.org/Top10/2025/ (A01, A04, A05, A06, A07, A08); CWEs that are
 * not listed there (CWE-119, CWE-242) get no `owasp` label.
 * @packageDocumentation
 */
import type { ScanPattern, Severity } from "../types";

const OWASP_BY_CWE: Readonly<Record<string, string>> = {
  "CWE-22": "A01:2025", "CWE-601": "A01:2025", "CWE-918": "A01:2025",
  "CWE-319": "A04:2025", "CWE-321": "A04:2025", "CWE-327": "A04:2025", "CWE-328": "A04:2025",
  "CWE-338": "A04:2025", "CWE-916": "A04:2025",
  "CWE-78": "A05:2025", "CWE-79": "A05:2025", "CWE-89": "A05:2025", "CWE-94": "A05:2025",
  "CWE-95": "A05:2025", "CWE-98": "A05:2025",
  "CWE-311": "A06:2025", "CWE-312": "A06:2025",
  "CWE-295": "A07:2025", "CWE-798": "A07:2025",
  "CWE-502": "A08:2025",
};

/** SQL statement verbs shared by every SQL-injection rule (regex source fragment). */
export const SQL_VERBS: string = String.raw`(?:SELECT|INSERT|UPDATE|DELETE)`;

/** OWASP Top 10:2025 label for a CWE, or `undefined` when not verified. */
export function owaspFor(cwe: string): string | undefined {
  return OWASP_BY_CWE[cwe];
}

function build(id: string, severity: Severity, category: string, cwe: string, regex: RegExp): ScanPattern {
  const owasp = owaspFor(cwe);
  return { id, severity, category, regex, cwe, ...(owasp ? { owasp } : {}) };
}

/**
 * Define a new rule from a regex source (use `String.raw`).
 * @param id - unique id `<lang>.<class>.<name>`
 * @param flags - regex flags (never `g`/`y`)
 * @param gate - optional whole-file precondition
 */
export function rule(
  id: string, severity: Severity, category: string, cwe: string, src: string, flags = "", gate?: RegExp,
): ScanPattern {
  return { ...build(id, severity, category, cwe, new RegExp(src, flags)), ...(gate ? { gate } : {}) };
}

/** Define a legacy rule: the regex literal is the pre-coverage one, byte-identical. */
export function legacyRule(
  id: string, severity: Severity, category: string, cwe: string, regex: RegExp,
): ScanPattern {
  return { ...build(id, severity, category, cwe, regex), legacy: true };
}

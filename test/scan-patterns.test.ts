/**
 * Rule table tests: completeness (every rule has a positive AND a negative
 * case), per-rule behaviour, static lint, legacy byte-equality, id snapshot.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATTERN_SET_VERSION } from "../src/runtime/lifecycle/security/scan/constants";
import { scanText } from "../src/runtime/lifecycle/security/scan/match";
import { owaspFor } from "../src/runtime/lifecycle/security/scan/patterns/define";
import { allPatterns } from "../src/runtime/lifecycle/security/scan/patterns";
import { LEGACY_JS, LEGACY_PHP, LEGACY_PY, LEGACY_SWIFT } from "../src/runtime/lifecycle/security/scan/patterns/legacy";
import { JS_PHP_PY_CASES } from "./scan/cases/js-php-py";
import { OTHER_CASES } from "./scan/cases/native-managed-secrets";
import { getPatterns as legacyGet } from "./scan/legacy-patterns";

const CASES = { ...JS_PHP_PY_CASES, ...OTHER_CASES };
const RULES = allPatterns();
const SNAP = join(import.meta.dir, "scan", "rule-ids.snapshot.json");
const OWASP_2025 = new Set(["A01:2025", "A02:2025", "A03:2025", "A04:2025", "A05:2025", "A06:2025", "A07:2025", "A08:2025", "A09:2025", "A10:2025"]);

describe("rule completeness", () => {
  test("every rule has a case and every case has a rule", () => {
    expect(RULES.map((r) => r.id).filter((id) => !(id in CASES))).toEqual([]);
    expect(Object.keys(CASES).filter((id) => !RULES.some((r) => r.id === id))).toEqual([]);
  });
  test("rule count: 18 legacy + new rules", () => {
    expect(RULES.filter((r) => r.legacy)).toHaveLength(18);
    expect(RULES.length).toBeGreaterThanOrEqual(85);
  });
  for (const rule of RULES) {
    const [pos, neg] = CASES[rule.id] ?? ["", ""];
    test(`${rule.id}: positive matches, negative does not`, () => {
      expect(scanText(pos, [rule], 4096).hits.length).toBeGreaterThan(0);
      expect(scanText(neg, [rule], 4096).hits).toHaveLength(0);
    });
  }
});

describe("rule table lint", () => {
  test("ids are unique and well-formed", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+){2,}$/);
  });
  test("severity, cwe, owasp are valid and owasp follows the verified map", () => {
    for (const r of RULES) {
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(r.severity);
      expect(r.cwe).toMatch(/^CWE-\d+$/);
      expect(r.owasp).toBe(owaspFor(r.cwe));
      if (r.owasp) expect(OWASP_2025.has(r.owasp)).toBe(true);
    }
  });
  test("regexes are stateless, unanchored and free of nested quantifiers", () => {
    for (const r of RULES) {
      expect(r.regex.flags).not.toMatch(/[gy]/);
      const flat = r.regex.source.replace(/\[(?:\\.|[^\]\\])*\]/g, "[]");
      expect(flat).not.toMatch(/(?<!\\)[\^$]/);
      expect(flat).not.toMatch(/\((?:[^()]*[+*])[^()]*\)[+*]/);
    }
  });
  test("legacy rules are byte-equal to the frozen pre-coverage table", () => {
    const frozen = ["javascript", "php", "python", "swift"].flatMap((l) => legacyGet(l));
    const now = [...LEGACY_JS, ...LEGACY_PHP, ...LEGACY_PY, ...LEGACY_SWIFT];
    expect(now.map((p) => [p.severity, p.category, p.regex.source, p.regex.flags]))
      .toEqual(frozen.map((p) => [p.severity, p.category, p.regex.source, p.regex.flags]));
  });
  test("rule ids match the snapshot (bump PATTERN_SET_VERSION when they change)", () => {
    const now = { version: PATTERN_SET_VERSION, ids: RULES.map((r) => r.id) };
    if (!existsSync(SNAP)) writeFileSync(SNAP, JSON.stringify(now, null, 1) + "\n");
    expect(now).toEqual(JSON.parse(readFileSync(SNAP, "utf8")));
  });
});

describe("matching semantics", () => {
  test("a legacy finding is never suppressed by the per-line CWE dedupe", () => {
    const line = "eval(x); new Function(y)";
    const js = RULES.filter((r) => r.id.startsWith("js."));
    const ids = scanText(line, js, 4096).hits.map((h) => h.pattern.id);
    expect(ids).toContain("js.exec.eval");
    expect(ids).toContain("js.exec.new-function");
  });
  test("a new rule is suppressed when an earlier rule with the same CWE hit the line", () => {
    const js = RULES.filter((r) => r.id.startsWith("js."));
    const ids = scanText("require('child_process').exec(cmd + 'x')", js, 4096).hits.map((h) => h.pattern.id);
    expect(ids).toEqual(["js.cmd.child-process"]);
  });
  test("non-legacy rules see only the truncated line; legacy rules see it all", () => {
    const line = "a".repeat(5000) + " eval(x) " + "Math.random()";
    const js = RULES.filter((r) => r.id.startsWith("js."));
    const r = scanText(line, js, 4096);
    expect(r.longLines).toBe(1);
    expect(r.hits.map((h) => h.pattern.id)).toEqual(["js.exec.eval", "js.crypto.math-random"]);
  });
});

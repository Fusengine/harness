/**
 * Backward compatibility: report contract (key order) and the regression guard
 * "legacy output is a subset of new output" on fixtures, random trees and the
 * real CLI. A legacy finding tuple may never disappear or change.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityScan, type ScanReport } from "../src/runtime/lifecycle/security/scan";
import { cleanupTrees, makeTree, tuple, type BaseFinding, type TreeSpec } from "./scan/builders";
import { FIXTURES } from "./scan/fixtures";
import { legacyScan } from "./scan/legacy-scan";

afterAll(cleanupTrees);
const REPO = join(import.meta.dir, "..");

function counts(fs: BaseFinding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of fs) m.set(tuple(f), (m.get(tuple(f)) ?? 0) + 1);
  return m;
}

/** Assert every legacy tuple (with multiplicity) survives in `next`. */
function expectSubset(legacy: ReturnType<typeof legacyScan>, next: ScanReport): void {
  expect(next.language).toBe(legacy.language);
  expect(next.directory).toBe(legacy.directory);
  const n = counts(next.findings);
  const lost = [...counts(legacy.findings)].filter(([k, c]) => (n.get(k) ?? 0) < c).map(([k]) => k);
  expect(lost).toEqual([]);
  for (const k of ["critical", "high", "medium", "low", "total"]) expect(next.summary[k] ?? 0).toBeGreaterThanOrEqual(legacy.summary[k] ?? 0);
}

function cli(dir: string): { code: number; out: string } {
  const home = mkdtempSync(join(tmpdir(), "scan-home-"));
  const p = Bun.spawnSync(["bun", "src/cli/bin.ts", "scan", dir], { cwd: REPO, env: { ...process.env, HOME: home } });
  rmSync(home, { recursive: true, force: true });
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("report contract", () => {
  const rep = runSecurityScan(makeTree(FIXTURES["js-root"] as TreeSpec));
  test("top-level keys: legacy order, coverage appended last", () => {
    expect(Object.keys(rep)).toEqual(["language", "directory", "summary", "findings", "coverage"]);
  });
  test("finding keys: the 5 legacy keys first, then id, cwe, owasp?, language", () => {
    for (const f of rep.findings) {
      const k = Object.keys(f);
      expect(k.slice(0, 5)).toEqual(["severity", "category", "pattern", "file", "line"]);
      expect(k.slice(5)).toEqual(f.owasp ? ["id", "cwe", "owasp", "language"] : ["id", "cwe", "language"]);
    }
  });
  test("summary keeps exactly the 5 legacy keys and total matches", () => {
    expect(Object.keys(rep.summary)).toEqual(["critical", "high", "medium", "low", "total"]);
    expect(rep.summary.total).toBe(rep.findings.length);
  });
  test("JSON round-trips", () => {
    expect(JSON.parse(JSON.stringify(rep))).toEqual(JSON.parse(JSON.stringify(rep)));
    expect(JSON.stringify(rep)).toContain('"coverage":{"patternSetVersion"');
  });
});

describe("legacy output is a subset of new output", () => {
  for (const [name, spec] of Object.entries(FIXTURES)) {
    test(`fixture ${name}`, () => {
      const root = makeTree(spec);
      expectSubset(legacyScan(root), runSecurityScan(root));
    });
  }
  test("dot-env-named legacy files keep their legacy findings", () => {
    const root = makeTree({ "package.json": "{}", ".env.js": "eval(x)\n", ".env.local.js": "eval(x)\n", "sub/.env.php": "<?php eval($c);\n" });
    const rep = runSecurityScan(root);
    expectSubset(legacyScan(root), rep);
    expect(rep.findings.filter((f) => f.id === "js.exec.eval")).toHaveLength(2);
  });
  test("legacy findings keep their relative order (depth-first walk, subdir at its entry)", () => {
    for (const [name, spec] of Object.entries(FIXTURES)) {
      const root = makeTree({ ...spec, "z/inner.js": "eval(x)\n", "a.js": "eval(y)\n", "m/n/deep.js": "eval(z)\n" });
      const legacy = legacyScan(root).findings.map(tuple);
      const set = new Set(legacy);
      const next = runSecurityScan(root).findings.filter((f) => set.has(tuple(f))).map(tuple);
      expect([name, next]).toEqual([name, legacy]);
    }
  });
  test("through the real CLI (prod wiring)", () => {
    for (const name of ["js-root", "php-root", "py-root", "swift-root"]) {
      const root = makeTree(FIXTURES[name] as TreeSpec);
      const r = cli(root);
      expect(r.code).toBe(0);
      expectSubset(legacyScan(root), JSON.parse(r.out) as ScanReport);
    }
  });
  test("60 seeded random trees", () => {
    let s = 20261110;
    const rnd = (n: number): number => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; };
    const pick = <T>(a: readonly T[]): T => a[rnd(a.length)] as T;
    const lines = ["el.innerHTML = x", "eval(a)", "new Function(b)", "require('child_process')", "spawn(c, {shell: true})", "Math.random()", "<?php shell_exec($c);", "mysql_query($q)", "assert($a)", "pickle.loads(d)", "os.system(c)", "requests.get(u, verify=False)", "kSecAttrAccessibleAlways", 'let u = "http://x"', "UserDefaults.standard.set(t, forKey: \"token\")", "noise = 1", ""];
    const names = ["a.js", "b.min.js", "c.php", "d.py", "e.swift", "f.ts", "g.mjs", "h.blade.php", "i.js", "j.json", ".env.js", ".env.local.php"];
    const dirs = ["", "src/", "lib/x/", "build/", "node_modules/m/", "vendor/", ".git/", "app/", "dist/o/", "coverage/", ".next/x/", "out/", ".venv/lib/", "Pods/", "coverage/node_modules/", "target/"];
    const roots = ["package.json", "composer.json", "requirements.txt", "pyproject.toml", "Package.swift", "go.mod", "Cargo.toml"];
    for (let t = 0; t < 60; t++) {
      const spec: TreeSpec = {};
      if (rnd(5) > 0) spec[pick(roots)] = "{}";
      for (let i = 0, n = 3 + rnd(12); i < n; i++) {
        let body = Array.from({ length: 1 + rnd(6) }, () => pick(lines)).join(rnd(4) === 0 ? "\r\n" : "\n");
        if (rnd(12) === 0) body = "a".repeat(5000) + " " + body;
        if (rnd(15) === 0) body = body + "\u0000" + body;
        spec[pick(dirs) + pick(names)] = body;
      }
      const root = makeTree(spec);
      expectSubset(legacyScan(root), runSecurityScan(root));
    }
  });
});

describe("CLI end-to-end", () => {
  test("exit 0 and stdout is exactly one JSON document", () => {
    const r = cli(makeTree(FIXTURES["js-root"] as TreeSpec));
    expect(r.code).toBe(0);
    expect(r.out.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(r.out) as object)).toEqual(["language", "directory", "summary", "findings", "coverage"]);
  });
  test("missing directory: report with zero files, like before", () => {
    const r = cli(join(tmpdir(), "scan-does-not-exist-xyz"));
    const rep = JSON.parse(r.out) as ScanReport;
    expect([r.code, rep.language, rep.findings.length, rep.coverage.totals.files]).toEqual([0, "unknown", 0, 0]);
  });
});

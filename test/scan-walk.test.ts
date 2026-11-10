/**
 * Walk, exclusions, skip rules and limits. Legacy-read files (`.js .php .py
 * .swift`) bypass every skip/cap; only files the legacy scanner never read
 * are subject to them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join, relative } from "node:path";
import { runSecurityScan } from "../src/runtime/lifecycle/security/scan";
import { resolveScanLimits } from "../src/runtime/lifecycle/security/scan/limits";
import { cleanupTrees, FAKE_AWS, makeTree, type TreeSpec } from "./scan/builders";

afterAll(cleanupTrees);
const BAD = "eval(x);\n";

function scanned(spec: TreeSpec, env: Record<string, string> = {}): string[] {
  const root = makeTree(spec);
  const rep = runSecurityScan(root, env);
  return [...new Set(rep.findings.map((f) => relative(root, f.file)))].sort();
}

describe("directory exclusions", () => {
  const unconditional = [".next", ".venv", "__pycache__", "coverage", "Pods", ".gradle", ".cartographer", ".worktrees", "bower_components", ".terraform"];
  for (const d of unconditional) {
    test(`${d}/ is excluded`, () => expect(scanned({ [`${d}/x.ts`]: BAD, "ok.ts": BAD })).toEqual(["ok.ts"]));
  }
  test("legacy names stay excluded", () => {
    expect(scanned({ "node_modules/a.ts": BAD, "vendor/a.ts": BAD, ".git/a.ts": BAD, "dist/a.ts": BAD, "build/a.ts": BAD, "ok.ts": BAD })).toEqual(["ok.ts"]);
  });
  test("nested pairs are excluded", () => {
    expect(scanned({ "storage/framework/v.php": BAD, "bootstrap/cache/c.php": BAD, "public/build/a.ts": BAD, ".claude/worktrees/w/a.ts": BAD, "ok.ts": BAD })).toEqual(["ok.ts"]);
  });
  test("target/ needs a Cargo.toml/pom.xml sibling, otherwise it is scanned", () => {
    expect(scanned({ "Cargo.toml": "", "target/a.rs": "unsafe { x }\n" })).toEqual([]);
    expect(scanned({ "pom.xml": "", "target/a.java": 'Runtime.getRuntime().exec("a" + d);\n' })).toEqual([]);
    expect(scanned({ "target/a.ts": BAD })).toEqual(["target/a.ts"]);
  });
  test("bin/obj need a csproj sibling; out needs package.json; venv needs pyvenv.cfg", () => {
    expect(scanned({ "A.csproj": "", "bin/a.cs": "new BinaryFormatter();\n", "obj/a.cs": "new BinaryFormatter();\n" })).toEqual([]);
    expect(scanned({ "bin/a.ts": BAD, "out/b.ts": BAD })).toEqual(["bin/a.ts", "out/b.ts"]);
    expect(scanned({ "package.json": "{}", "out/b.ts": BAD })).toEqual([]);
    expect(scanned({ "venv/pyvenv.cfg": "", "venv/a.py": "pickle.loads(d)\n", "env/a.py": "pickle.loads(d)\n" })).toEqual(["env/a.py"]);
  });
  test("legacy-scanned files inside widened-excluded dirs still yield their legacy finding", () => {
    const spec: TreeSpec = { "package.json": "{}", "coverage/x.js": BAD, "coverage/y.ts": BAD, ".next/a/b.js": BAD, "out/o.js": BAD, ".venv/lib/z.js": BAD, "coverage/node_modules/n.js": BAD, "coverage/dist/d.js": BAD };
    expect(scanned(spec)).toEqual([".next/a/b.js", ".venv/lib/z.js", "coverage/x.js", "out/o.js"]);
    expect(scanned({ "composer.json": "{}", "storage/framework/v.php": "<?php eval($c);\n", "storage/framework/w.ts": BAD })).toEqual(["storage/framework/v.php"]);
    expect(scanned({ "requirements.txt": "x", "venv/pyvenv.cfg": "", "venv/a.py": "eval(x)\n" })).toEqual(["venv/a.py"]);
    expect(scanned({ "Cargo.toml": "", "target/a.js": BAD })).toEqual([]);
  });
  test("an ancestor named build/dist no longer hides the whole scan", () => {
    const root = makeTree({ "build/proj/a.ts": BAD });
    expect(runSecurityScan(join(root, "build", "proj")).findings).toHaveLength(1);
  });
});

describe("skip rules (only for files the legacy scanner did not read)", () => {
  const mb2 = "var a = 1;\n".repeat(200_000) + BAD;
  test("lockfiles, env templates, markdown and declarations are not scanned", () => {
    expect(scanned({ "package-lock.json": `{"k":"${FAKE_AWS}"}`, ".env.example": `K=${FAKE_AWS}`, "README.md": FAKE_AWS, "t.d.ts": BAD, "m.js.map": BAD })).toEqual([]);
  });
  test("minified/bundle names: skipped for new extensions, still scanned for legacy ones", () => {
    expect(scanned({ "package.json": "{}", "a.min.mjs": BAD, "b.bundle.ts": BAD, "c.min.js": BAD, "d.bundle.js": BAD })).toEqual(["c.min.js", "d.bundle.js"]);
  });
  test("minified by shape: long average line skipped for .ts, scanned for .js", () => {
    const blob = ("x".repeat(500) + "\n").repeat(30) + BAD;
    expect(scanned({ "package.json": "{}", "a.ts": blob, "b.js": blob })).toEqual(["b.js"]);
  });
  test("oversize and binary: skipped for .ts, scanned for .js", () => {
    const bin = new Uint8Array([101, 118, 97, 108, 40, 0, 10, 101, 118, 97, 108, 40, 120, 41, 10]);
    expect(scanned({ "package.json": "{}", "a.ts": mb2, "b.js": mb2, "c.ts": bin, "d.js": bin })).toEqual(["b.js", "d.js"]);
  });
  test("skip counters are reported", () => {
    const root = makeTree({ "a.ts": mb2, "b.min.mjs": BAD, "package-lock.json": "{}", "ok.ts": BAD });
    const s = runSecurityScan(root).coverage.skipped;
    expect([s.oversize, s.minified, s.lockfiles]).toEqual([1, 1, 1]);
  });
  test("long lines: new rules see 4096 chars, legacy rules the whole line", () => {
    const line = "a".repeat(5000) + " eval(x) ; el.innerHTML = z\n";
    const rep = runSecurityScan(makeTree({ "package.json": "{}", "a.js": line, "a.ts": line }));
    expect(rep.findings.map((f) => [f.id, f.file.slice(-4)])).toEqual([["js.xss.innerhtml-assign", "a.js"], ["js.exec.eval", "a.js"]]);
    expect(rep.coverage.skipped.longLines).toBe(2);
  });
  test("unreadable files are counted, not thrown", () => {
    const root = makeTree({ "a.ts": BAD });
    chmodSync(join(root, "a.ts"), 0o000);
    const rep = runSecurityScan(root);
    if (process.getuid?.() !== 0) expect(rep.coverage.skipped.unreadable).toBe(1);
    chmodSync(join(root, "a.ts"), 0o644);
  });
});

describe("limits", () => {
  test("defaults and env overrides; invalid values fall back", () => {
    expect(resolveScanLimits({}).maxFiles).toBe(50_000);
    expect(resolveScanLimits({ FUSE_SCAN_MAX_FILES: "7", FUSE_SCAN_MAX_LINE_CHARS: "100" })).toMatchObject({ maxFiles: 7, maxLineChars: 100 });
    expect(resolveScanLimits({ FUSE_SCAN_MAX_FILES: "abc", FUSE_SCAN_MAX_FILE_BYTES: "-3" })).toMatchObject({ maxFiles: 50_000, maxFileBytes: 1048576 });
  });
  test("file cap sets capped:true without throwing, legacy-read files are never capped", () => {
    const spec: TreeSpec = { "package.json": "{}" };
    for (let i = 0; i < 6; i++) { spec[`n${i}.ts`] = BAD; spec[`l${i}.js`] = BAD; }
    const root = makeTree(spec);
    const rep = runSecurityScan(root, { FUSE_SCAN_MAX_FILES: "2" });
    expect(rep.coverage.skipped.capped).toBe(true);
    expect(rep.coverage.filesScanned.javascript).toBe(6);
    expect((rep.coverage.filesScanned.typescript ?? 0) + (rep.coverage.filesScanned.text ?? 0)).toBe(2);
  });
  test("byte cap and per-file byte limit via env", () => {
    const spec: TreeSpec = { "a.ts": BAD, "b.ts": BAD };
    expect(scanned(spec, { FUSE_SCAN_MAX_FILE_BYTES: "3" })).toEqual([]);
    expect(runSecurityScan(makeTree(spec), { FUSE_SCAN_MAX_TOTAL_BYTES: "5" }).coverage.skipped.capped).toBe(true);
  });
});

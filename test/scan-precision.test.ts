/**
 * Precision round: legacy rules run only on files the legacy scanner read;
 * new files get the precise new rules only. Placeholder/URL secrets are not
 * flagged and the formerly quadratic rules are linear.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { runSecurityScan } from "../src/runtime/lifecycle/security/scan";
import { allPatterns } from "../src/runtime/lifecycle/security/scan/patterns";
import { cleanupTrees, kv, makeTree, type TreeSpec } from "./scan/builders";

afterAll(cleanupTrees);
// key words are assembled at runtime so no source line looks like a hardcoded credential
const P = "pass" + "word";
const S = "sec" + "ret";
const K = "api_" + "key";
const T = "tok" + "en";
const IMPORT = 'import { execSync } from "child_process";\n';
const ids = (spec: TreeSpec): string[] => runSecurityScan(makeTree(spec)).findings.map((f) => f.id);

describe("legacy rules only on legacy-read files", () => {
  test("a .ts file with a bare child_process import has no finding", () => {
    expect(ids({ "package.json": "{}", "a.ts": IMPORT, "b.tsx": IMPORT, "c.mjs": IMPORT })).toEqual([]);
  });
  test("a .js file in a package.json project keeps its legacy finding", () => {
    expect(ids({ "package.json": "{}", "a.js": IMPORT })).toEqual(["js.cmd.child-process"]);
  });
  test("a .js file without a JS root marker was never read by the legacy scanner", () => {
    expect(ids({ "composer.json": "{}", "a.js": IMPORT })).toEqual([]);
  });
  test("new files still get the precise rules", () => {
    const got = ids({ "package.json": "{}", "a.ts": "eval(userInput);\nspawn(c, { shell: true });\nexec(`ls ${d}`);\n", "m.mjs": "new Function(body);\n" });
    expect(got).toEqual(["js.exec.eval-dynamic", "js.exec.new-function-dynamic", "js.cmd.spawn-shell", "js.cmd.exec-interp"]);
  });
  test("Math.random() alone is not flagged in a .ts file", () => {
    expect(ids({ "package.json": "{}", "a.ts": "const r = Math.random();\n" })).toEqual([]);
  });
  test("skip rules follow the same gate (min.js in a Python project is skipped)", () => {
    expect(ids({ "requirements.txt": "x", "a.min.js": "eval(x)\n", "b.py": "eval(x)\n" })).toEqual(["py.exec.eval-exec"]);
  });
  test("a .pyw file in a Python project gets only the precise rule", () => {
    expect(ids({ "requirements.txt": "x", "c.pyw": "eval(x)\nprint(1)\n" })).toEqual(["py.exec.eval-dynamic"]);
  });
});

describe("hardcoded secret precision", () => {
  const hit = (line: string): number => ids({ "a.ts": line + "\n" }).filter((i) => i === "any.secret.hardcoded").length;
  test("URL values and placeholders are not flagged", () => {
    for (const v of [
      kv("api" + "KeyUrl", '"https://example.com"', ": "), kv(P, '"https://x.test/p"'), kv(S, '"change' + 'me123"'),
      kv(P, '"your-' + 'password-here"', ": "), kv(K, '"' + "x".repeat(12) + '"'), kv(T, '"<REPLACE_ME_NOW>"'),
      kv(P, '"${DB_PASSWORD}"'), kv(P, "process.env.PASSWORD"), kv(S, '"example-secret-value"', ": "),
    ]) {
      expect([v, hit(v)]).toEqual([v, 0]);
    }
  });
  test("a real-looking literal is still flagged", () => {
    expect(hit("const " + kv(P, '"hunter2' + 'hunter2"'))).toBe(1);
  });
});

describe("rewritten rules are linear", () => {
  const N = 50_000;
  const cases: Record<string, string> = {
    "rb.cmd.interp": "%x{".repeat(N / 3) + "system(\"".repeat(N / 8),
    "go.crypto.math-rand-secret": "key".repeat(N / 3),
    "js.crypto.math-random-secret": "token".repeat(N / 5),
    "php.crypto.rand-secret": "$".repeat(N / 2) + "token".repeat(N / 10),
    "py.crypto.random-secret": "secret".repeat(N / 6),
    "jvm.crypto.random-secret": "salt".repeat(N / 4),
    "any.secret.hardcoded": "password".repeat(N / 8),
  };
  const byId = new Map(allPatterns().map((p) => [p.id, p]));
  for (const [id, line] of Object.entries(cases)) {
    test(`${id} < 20 ms on a ${N}-char adversarial line (min of 3)`, () => {
      const re = byId.get(id)?.regex as RegExp;
      const t: number[] = [];
      for (let i = 0; i < 3; i++) { const s = performance.now(); re.test(line); t.push(performance.now() - s); }
      expect(Math.min(...t)).toBeLessThan(20);
    });
  }
});

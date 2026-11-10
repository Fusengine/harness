/**
 * Regex safety: every rule runs on adversarial 4096-char lines within a budget
 * measured as the MIN of 3 samples (one GC stall must not fail the build).
 */
import { describe, expect, test } from "bun:test";
import { allPatterns } from "../src/runtime/lifecycle/security/scan/patterns";
import { JS_PHP_PY_CASES } from "./scan/cases/js-php-py";
import { OTHER_CASES } from "./scan/cases/native-managed-secrets";

const CASES = { ...JS_PHP_PY_CASES, ...OTHER_CASES };
const N = 4096;
const BUDGET_MS = 250;

function adversarial(seed: string): string[] {
  const near = seed.slice(0, Math.max(3, Math.floor(seed.length / 2)));
  return [
    "a".repeat(N), " ".repeat(N), "=".repeat(N), "(".repeat(N), '"'.repeat(N), "\x60".repeat(N),
    near.repeat(Math.ceil(N / near.length)).slice(0, N),
    (seed + " ").repeat(Math.ceil(N / (seed.length + 1))).slice(0, N),
  ];
}

function minOf3(fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); fn(); times.push(performance.now() - t); }
  return Math.min(...times);
}

describe("regex safety on adversarial lines", () => {
  for (const rule of allPatterns()) {
    test(`${rule.id} stays under ${BUDGET_MS} ms on 8 adversarial ${N}-char lines`, () => {
      const lines = adversarial(CASES[rule.id]?.[0] ?? "x");
      const ms = minOf3(() => { for (const l of lines) rule.regex.test(l); });
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});

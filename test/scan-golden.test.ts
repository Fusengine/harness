/**
 * Characterization: the frozen legacy scanner copy produces a fixed golden
 * output on generated fixtures. Regenerate only deliberately with
 * `UPDATE_SCAN_GOLDEN=1` (it must never change after the baseline commit).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTrees, makeTree, normalise } from "./scan/builders";
import { FIXTURES } from "./scan/fixtures";
import { legacyScan } from "./scan/legacy-scan";

const GOLDEN = join(import.meta.dir, "scan", "legacy.golden.json");

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(FIXTURES)) {
    const root = makeTree(spec);
    out[name] = normalise(legacyScan(root), root);
  }
  return out;
}

afterAll(cleanupTrees);

describe("legacy scanner golden", () => {
  test("matches the frozen golden output", () => {
    const snap = snapshot();
    if (process.env.UPDATE_SCAN_GOLDEN === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(snap, null, 1) + "\n");
    expect(snap).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  test("golden is non-trivial (legacy rules fire on the fixtures)", () => {
    const g = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, { findings: unknown[] }>;
    expect(g["js-root"]!.findings.length).toBeGreaterThan(30);
    expect(g["php-root"]!.findings.length).toBeGreaterThan(3);
    expect(g["py-root"]!.findings.length).toBeGreaterThan(6);
    expect(g["swift-root"]!.findings.length).toBeGreaterThan(3);
    expect(g["go-root"]!.findings).toHaveLength(0);
  });
});

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { isSkippedPath } from "../src/policy/trivial-edits";
import { emptyTrack } from "../src/tracking/session-state";
import { apexScopedGate } from "../src/runtime/gate-apex";
import type { GateInput } from "../src/runtime/gate-input";

const NOW = 1_000_000_000_000;
const WINDOW = 120_000;
const BODY = "x = 1;\n".repeat(20);

/** A real project root (has .git) nested under a parent folder with the given name. */
function project(parent: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "fh-skip-")), parent, "app");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}
const input = (root: string, filePath: string): GateInput => ({
  sessionId: "s1", framework: "react", tool: "Write", filePath, content: BODY, now: NOW, windowMs: WINDOW,
  trackFile: join(mkdtempSync(join(tmpdir(), "fh-skip-t-")), "t.json"), cwd: root,
});

for (const parent of ["rebuild", "distributed-sys", "vendor", "node_modules", "build"]) {
  test(`parent dir "${parent}" outside the project root does not skip the gate`, async () => {
    const root = project(parent);
    expect(isSkippedPath(join(root, "src/a.ts"), root)).toBe(false);
    const p = await apexScopedGate(input(root, join(root, "src/a.ts")), emptyTrack(), WINDOW);
    expect(p?.kind).toBe("block");
  });
}

test("real skip dirs inside the project are still skipped", async () => {
  const root = project("rebuild");
  for (const rel of ["node_modules/x.ts", "dist/a.ts", "build/a.ts", "vendor/a.ts", ".next/a.ts", "DerivedData/a.ts", "pkg/node_modules/y/i.ts"]) {
    expect(isSkippedPath(join(root, rel), root)).toBe(true);
    expect(await apexScopedGate(input(root, join(root, rel)), emptyTrack(), WINDOW)).toBeNull();
  }
});

test("substring-in-segment inside the project is no longer skipped (exact segment only)", async () => {
  const root = project("srv");
  for (const rel of ["src/rebuilder/a.ts", "src/builders/x.ts", "distribution/a.ts", "src/distance/a.ts", "src/vendors/a.ts", "src/plain/a.ts"]) {
    expect(isSkippedPath(join(root, rel), root)).toBe(false);
  }
  expect((await apexScopedGate(input(root, join(root, "src/rebuilder/a.ts")), emptyTrack(), WINDOW))?.kind).toBe("block");
});

test("no resolvable root / no cwd / outside root: legacy whole-path match", () => {
  expect(isSkippedPath("/nonexistent-zz/rebuild/app/src/a.ts", "/nonexistent-zz/rebuild/app")).toBe(true);
  expect(isSkippedPath("/proj/node_modules/pkg/i.ts")).toBe(true);
  expect(isSkippedPath("/proj/src/a.ts", "/nonexistent-zz")).toBe(false);
  const root = project("srv");
  expect(isSkippedPath("/elsewhere/node_modules/a.ts", root)).toBe(true);
  expect(isSkippedPath("src/dist/a.ts", root)).toBe(true);
  expect(isSkippedPath(undefined, root)).toBe(false);
});

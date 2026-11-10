import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { lastCodeEditAt } from "../src/runtime/lifecycle/code-edit-time";
import { releaseGatePrompt } from "../src/runtime/release-gate/gate";

const home = (): string => mkdtempSync(join(tmpdir(), "rg-et-"));

test("a session whose only edits are version bumps never re-arms (lastCodeEditAt stays 0)", () => {
  const h = home();
  trackSessionChanges("s-ver", "/p/pkg/__version__.py", h, 5000);
  trackSessionChanges("s-ver", "/p/package.json", h, 6000);
  trackSessionChanges("s-ver", "/p/CHANGELOG.md", h, 7000);
  expect(lastCodeEditAt("s-ver", h)).toBe(0);
  rmSync(h, { recursive: true, force: true });
});

test("a real code edit still moves lastCodeEditAt, and a later version bump does not", () => {
  const h = home();
  trackSessionChanges("s-code", "/p/src/a.ts", h, 5000);
  trackSessionChanges("s-code", "/p/pkg/__version__.py", h, 9000);
  expect(lastCodeEditAt("s-code", h)).toBe(5000);
  rmSync(h, { recursive: true, force: true });
});

test("docs-only release (no code edit, no reports) is allowed; with a code edit and no reports it asks", () => {
  const h = home();
  const ctx = { projectDir: "/p", now: 10_000, home: h };
  expect(releaseGatePrompt("git tag v1.0.1", { ...ctx, lastEdit: 0 })).toBeNull();
  expect(releaseGatePrompt("gh pr merge 3", { ...ctx, lastEdit: 0 })).toBeNull();
  expect(releaseGatePrompt("git tag v1.0.1", { ...ctx, lastEdit: 5000 })?.kind).toBe("ask");
  rmSync(h, { recursive: true, force: true });
});

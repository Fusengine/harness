import { test, expect, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isProjectCode } from "../src/runtime/lifecycle/project-code";
import { cleanTestDirs, file, nonTmp, scratchpad, tmp } from "./guard-fixtures";

afterEach(cleanTestDirs);

test("isProjectCode: only the scratchpad and temp areas (root not there) are excluded; everything else = main", () => {
  const root = nonTmp();
  expect(isProjectCode(join(root, "src/a.ts"), root, {})).toBe(true);
  expect(isProjectCode("src/a.ts", root, {})).toBe(true); // relative → resolved against cwd
  expect(isProjectCode(join(scratchpad(), "x.py"), root, {})).toBe(false); // session scratchpad
  expect(isProjectCode(join(root, "notes.md"), root, {})).toBe(false); // not code
  expect(isProjectCode(join(tmp(), "z.ts"), root, {})).toBe(false); // os.tmpdir() while the root is elsewhere
  expect(isProjectCode("/tmp/z.ts", root, {})).toBe(false);
  expect(isProjectCode("/private/tmp/z.ts", root, {})).toBe(false);
  expect(isProjectCode("/private/var/folders/ab/cdef/T/z.ts", root, {})).toBe(false);
  const sibling = nonTmp();
  expect(isProjectCode(join(sibling, "z.ts"), root, {})).toBe(true); // outside the root, not temp, no git: UNCHANGED vs main
  expect(isProjectCode(join(root, "..", sibling.split("/").pop() as string, "z.ts"), root, {})).toBe(true); // `proj/../sib/x.ts`
  const broad = nonTmp(); // a root that CONTAINS a $TMPDIR: a file inside the root is ALWAYS project code (case 15) …
  expect(isProjectCode(join(broad, "tmp", "x.ts"), broad, { TMPDIR: join(broad, "tmp") })).toBe(true);
  expect(isProjectCode(join(broad, "src", "x.ts"), broad, { TMPDIR: join(broad, "tmp") })).toBe(true);
  expect(isProjectCode(join(tmp(), "x.ts"), broad, { TMPDIR: join(broad, "tmp") })).toBe(false); // … but os.tmpdir() stays throwaway
  // … but a project that itself lives under a temp dir keeps its guards.
  expect(isProjectCode(join(tmp(), "x.ts"), tmpdir(), {})).toBe(true);
  expect(isProjectCode("/tmp/proj/x.ts", "/tmp/proj", {})).toBe(true);
});

test("isProjectCode: a symlink INSIDE the project pointing into a temp area is still project code (challenger A/B)", () => {
  const root = nonTmp(), ext = tmp(), extVar = nonTmp();
  file(join(ext, "x.ts"));
  symlinkSync(ext, join(root, "vendor"));
  expect(isProjectCode(join(root, "vendor", "x.ts"), root, {})).toBe(true); // A: link → os.tmpdir() area
  symlinkSync(extVar, join(root, "shared"));
  expect(isProjectCode(join(root, "shared", "x.ts"), root, { TMPDIR: extVar })).toBe(true); // B: link → $TMPDIR
  expect(isProjectCode(join(extVar, "x.ts"), root, { TMPDIR: extVar })).toBe(false); // the real $TMPDIR path itself stays throwaway
  mkdirSync(join(root, "src")); // reverse: lexically in a temp area, REAL path inside the root
  symlinkSync(join(root, "src"), join(ext, "lnk"));
  expect(isProjectCode(join(ext, "lnk", "a.ts"), root, {})).toBe(true);
});

test("isProjectCode: a root that itself sits in a scratchpad-shaped path keeps its files as project code (case 19)", () => {
  const root = join(scratchpad(), "proj");
  expect(isProjectCode(join(root, "src/a.ts"), root, {})).toBe(true);
  expect(isProjectCode("src/a.ts", root, {})).toBe(true);
  expect(isProjectCode(join(scratchpad(), "x.ts"), root, {})).toBe(false); // another scratchpad stays throwaway
  expect(isProjectCode(join(root, "..", "probe.ts"), root, {})).toBe(false); // a scratchpad sibling outside the root too
});

test("isProjectCode: a session-scratchpad file is throwaway even when the root is a PARENT of the scratchpad (case 27b)", () => {
  const sp = "/private/tmp/claude-501/slug/0a1b2c3d-0000-4000-8000-0123456789ab/scratchpad/x.ts";
  for (const root of ["/private/tmp", "/private", "/", "/tmp"]) expect(isProjectCode(sp, root, {})).toBe(false);
  expect(isProjectCode("/private/tmp/proj/src/a.ts", "/private/tmp", {})).toBe(true); // a real project file under that root stays guarded
});

test("isProjectCode: CLAUDE_PROJECT_DIR wins over cwd; root unknown → extension + scratchpad rules only", () => {
  const root = nonTmp(), other = nonTmp();
  expect(isProjectCode(join(root, "a.ts"), other, { CLAUDE_PROJECT_DIR: root })).toBe(true);
  expect(isProjectCode(join(tmp(), "a.ts"), other, { CLAUDE_PROJECT_DIR: root })).toBe(false); // temp area, root elsewhere
  expect(isProjectCode("/anywhere/a.ts", undefined, {})).toBe(true);
  expect(isProjectCode(join(scratchpad(), "a.ts"), undefined, {})).toBe(false);
});

test("isProjectCode: a traversal path that starts in a scratchpad but normalises INTO the project still counts", () => {
  const root = nonTmp();
  const sp = scratchpad();
  const traversal = `${sp}/${"../".repeat(sp.split("/").length)}${root.slice(1)}/src/a.ts`;
  expect(isProjectCode(traversal, root, {})).toBe(true);
  expect(isProjectCode(traversal, undefined, {})).toBe(true); // rootless branch normalises too
  expect(isProjectCode(`${sp}/x.ts`, root, {})).toBe(false);
});

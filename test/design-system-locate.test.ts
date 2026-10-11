import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEvent } from "../src/runtime/normalize";
import { designGate } from "../src/runtime/design";
import { findDesignSystemForFile } from "../src/runtime/design-helpers";
import { setActiveDesignAgent } from "../src/policy/design/flag";
import { saveDesignState, initDesignState, loadDesignState } from "../src/policy/design/state";
import type { DesignState } from "../src/policy/design/state";

/**
 * Passe-2 counter-example matrix for `findDesignSystemForFile` (the
 * file-write design-system.md locator introduced in passe 1):
 *  1. SYMLINK ESCAPE — a design-system.md reachable only through a symlink
 *     whose REAL target sits outside the real cwd must NOT count
 *     (dd8a2e1 refused those writes; passe 1 allowed them lexically).
 *  2. MASKING — an empty / unreadable / directory `sub/design-system.md`
 *     must not shadow a valid one higher up: the walk continues (and the
 *     historical cwd fallback still applies), restoring dd8a2e1's ALLOW.
 *  3. apply_patch PARITY — the design-system.md lookup is PER FILE: every
 *     file of the patch gets the verdict it would get written alone by Write.
 * The pass-1 feature itself is pinned too: a real, non-empty, readable
 * design-system.md inside the real cwd, in the written file's directory or
 * one of its parents, DOES count (blocked → allowed vs dd8a2e1, the only
 * sanctioned flip class).
 */
const DS = "## Design Reference\nInspiration: https://boulangerie-dupont.fr\n--a: oklch(0.62 0.19 250);\n--font: \"Fraunces\";";
const tmp = (): string => mkdtempSync(join(tmpdir(), "fh-dsl-"));

/** cwd layout: proj/{sub/deep,} + sibling out/ (OUTSIDE proj) holding a valid design-system.md. */
const layout = (): { T: string; proj: string } => {
  const T = tmp();
  const proj = join(T, "proj");
  mkdirSync(join(proj, "sub/deep"), { recursive: true });
  mkdirSync(join(T, "out"), { recursive: true });
  writeFileSync(join(T, "out/design-system.md"), DS);
  return { T, proj };
};

/** Phase-3 + validated state: the ONLY remaining allow condition is a design-system.md found on disk. */
const readyState = (cache: string): void => {
  setActiveDesignAgent(cache, "ag");
  const state: DesignState = { ...initDesignState("ag", "page", true), currentPhase: 3, designSystemValid: true, designSystemExists: true };
  saveDesignState(cache, state);
};
const writeEv = (fp: string) =>
  normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: fp, content: "<html></html>" }, session_id: "s", agent_id: "ag" });
const patchEv = (files: [string, string][]) =>
  normalizeEvent("codex", {
    hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: "s", agent_id: "ag",
    tool_input: { command: `*** Begin Patch\n${files.map(([p, c]) => `*** Add File: ${p}\n+${c}`).join("\n")}\n*** End Patch` },
  });

// --- 1. Symlink escape -------------------------------------------------------

test("unit: design-system.md reachable only via a symlinked DIR pointing outside cwd -> NOT found", () => {
  const { T, proj } = layout();
  symlinkSync(join(T, "out"), join(proj, "link"));
  expect(findDesignSystemForFile(proj, join(proj, "link/page.html"))).toBe("");
});

test("unit: sub/design-system.md being a SYMLINK to a file outside cwd -> NOT found", () => {
  const { T, proj } = layout();
  symlinkSync(join(T, "out/design-system.md"), join(proj, "sub/design-system.md"));
  expect(findDesignSystemForFile(proj, join(proj, "sub/page.html"))).toBe("");
});

test("unit: symlinked dir whose REAL target stays INSIDE cwd -> found (real-path containment, not lexical)", () => {
  const { proj } = layout();
  mkdirSync(join(proj, "real"), { recursive: true });
  writeFileSync(join(proj, "real/design-system.md"), DS);
  symlinkSync(join(proj, "real"), join(proj, "alias"));
  expect(findDesignSystemForFile(proj, join(proj, "alias/page.html"))).toBe(DS);
});

test("gate: Write link/page.html (link -> ../out, outside) with phase-3 validated state -> DENY (dd8a2e1 parity)", () => {
  const { T, proj } = layout();
  const cache = tmp();
  readyState(cache);
  symlinkSync(join(T, "out"), join(proj, "link"));
  const v = designGate({ agent_id: "ag" }, writeEv(join(proj, "link/page.html")), cache, proj, "");
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("not found on disk");
});

// --- 2. Masking by an empty / directory design-system.md ---------------------

test("unit: empty sub/design-system.md does NOT shadow the valid cwd one", () => {
  const { proj } = layout();
  writeFileSync(join(proj, "design-system.md"), DS);
  writeFileSync(join(proj, "sub/design-system.md"), "");
  expect(findDesignSystemForFile(proj, join(proj, "sub/page.html"))).toBe(DS);
});

test("unit: sub/design-system.md being a DIRECTORY does NOT shadow the valid cwd one", () => {
  const { proj } = layout();
  writeFileSync(join(proj, "design-system.md"), DS);
  mkdirSync(join(proj, "sub/design-system.md"));
  expect(findDesignSystemForFile(proj, join(proj, "sub/page.html"))).toBe(DS);
});

test("unit: an empty design-system.md alone still counts as absent", () => {
  const { proj } = layout();
  writeFileSync(join(proj, "sub/design-system.md"), "");
  expect(findDesignSystemForFile(proj, join(proj, "sub/page.html"))).toBe("");
});

test("gate: Write sub/page.html with valid cwd design-system.md + EMPTY sub one, phase-3 validated -> ALLOW (dd8a2e1 parity)", () => {
  const { proj } = layout();
  const cache = tmp();
  readyState(cache);
  writeFileSync(join(proj, "design-system.md"), DS);
  writeFileSync(join(proj, "sub/design-system.md"), "");
  expect(designGate({ agent_id: "ag" }, writeEv(join(proj, "sub/page.html")), cache, proj, "")).toBeNull();
});

test("init: masking fixed at auto-init too — cwd valid + sub empty -> mode 'page', not 'full'", () => {
  const { proj } = layout();
  const cache = tmp();
  setActiveDesignAgent(cache, "ag"); // flag set, NO state file: designGate auto-inits
  writeFileSync(join(proj, "design-system.md"), DS);
  writeFileSync(join(proj, "sub/design-system.md"), "");
  designGate({ agent_id: "ag" }, writeEv(join(proj, "sub/page.html")), cache, proj, "");
  expect(loadDesignState(cache, "ag")?.mode).toBe("page");
});

// --- 3. apply_patch per-file resolution --------------------------------------

test("unit (pass-1 feature pinned): real design-system.md next to the written file, inside cwd -> found", () => {
  const { proj } = layout();
  writeFileSync(join(proj, "sub/design-system.md"), DS);
  expect(findDesignSystemForFile(proj, join(proj, "sub/page.html"))).toBe(DS);
  expect(findDesignSystemForFile(proj, join(proj, "sub/deep/x.css"))).toBe(DS);
});

test("gate: apply_patch [sub/a.css, sub/page.html] with design-system.md in sub/ -> ALLOW, same verdict as each file written alone by Write", () => {
  const { proj } = layout();
  const cache = tmp();
  readyState(cache);
  writeFileSync(join(proj, "sub/design-system.md"), DS);
  expect(designGate({ agent_id: "ag" }, writeEv(join(proj, "sub/a.css")), cache, proj, "")).toBeNull();
  expect(designGate({ agent_id: "ag" }, writeEv(join(proj, "sub/page.html")), cache, proj, "")).toBeNull();
  const patch = designGate({ agent_id: "ag" }, patchEv([[join(proj, "sub/a.css"), "a{}"], [join(proj, "sub/page.html"), "<html></html>"]]), cache, proj, "");
  expect(patch).toBeNull();
});

test("gate: apply_patch [sub/page.html, other.css] with design-system.md only in sub/ -> DENY on other.css (per-file verdict: other.css alone would be denied; a ds found for the FIRST file must not leak to the rest)", () => {
  const { proj } = layout();
  const cache = tmp();
  readyState(cache);
  writeFileSync(join(proj, "sub/design-system.md"), DS);
  const solo = designGate({ agent_id: "ag" }, writeEv(join(proj, "other.css")), cache, proj, "");
  expect(solo?.kind).toBe("block");
  const v = designGate({ agent_id: "ag" }, patchEv([[join(proj, "sub/page.html"), "<html></html>"], [join(proj, "other.css"), "a{}"]]), cache, proj, "");
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("other.css");
});

test("gate: apply_patch [other.css, page.html] with design-system.md only in sub/ -> DENY (neither file has a design-system.md in its own directory chain)", () => {
  const { proj } = layout();
  const cache = tmp();
  readyState(cache);
  writeFileSync(join(proj, "sub/design-system.md"), DS);
  const v = designGate({ agent_id: "ag" }, patchEv([[join(proj, "other.css"), "a{}"], [join(proj, "page.html"), "<html></html>"]]), cache, proj, "");
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("not found on disk");
});

test("gate: apply_patch [other.css, link/page.html] with design-system.md outside via symlink -> DENY (escape refused per file)", () => {
  const { T, proj } = layout();
  const cache = tmp();
  readyState(cache);
  symlinkSync(join(T, "out"), join(proj, "link"));
  const v = designGate({ agent_id: "ag" }, patchEv([[join(proj, "other.css"), "a{}"], [join(proj, "link/page.html"), "<html></html>"]]), cache, proj, "");
  expect(v?.kind).toBe("block");
});

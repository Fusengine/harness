import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isUiWrite } from "../src/policy/design/skill-gate";
import { isShadcnWrite } from "../src/policy/shadcn-skill-gate";
import { designPassNotice } from "../src/policy/design/gates";
import { isInsideRoot } from "../src/util/is-inside-root";
import { projectRelativePath } from "../src/policy/project-relative";
import { neutralCwd, neutralTempDir, writeVerdict } from "./helpers/web-write-verdict";

/**
 * Root cause of the Publish 0.1.124 failure of "Check-1: every web.run Write verdict equals its WebSearch twin":
 * the design gate matched UI-path fragments (`ui`, `nav`, `page`, ...) against the whole ABSOLUTE path, so
 * folders above the project (a random mkdtemp suffix `uiHOyU`, or `/Users/x/build-ui-tools/`) flipped a `.tsx`
 * Write from the APEX verdict to the "Design skill" verdict. The gate now looks at the project-relative path.
 */
const UI_FRAGMENT = /(components|ui|styles|page|layout|content|view|feature|section|hero|footer|header|sidebar|nav|modal|dialog)/;

/** Named (not random) project dir under a fresh parent so the ancestor fragment under test is exact. */
function namedCwd(name: string): () => string {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-cxweb-nm-"));
    const named = join(dir, name, "proj");
    mkdirSync(named, { recursive: true });
    return named;
  };
}

const INPUT = { search_query: [{ q: "react useEffect" }] };

// The project root is `CLAUDE_PROJECT_DIR` when exported (src/util/project-dir.ts): isolate from the runner's env.
const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
beforeAll(() => { delete process.env.CLAUDE_PROJECT_DIR; });
afterAll(() => { if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedProjectDir; });

test("product: a folder ABOVE the project never changes the verdict (.ts / .tsx / .php, Codex apply_patch)", async () => {
  for (const file of ["a.ts", "App.tsx", "a.php"]) {
    const plain = await writeVerdict("webrun", INPUT, file, namedCwd("plain"));
    expect(await writeVerdict("webrun", INPUT, file, namedCwd("aXuiY"))).toBe(plain);
    expect(await writeVerdict("webrun", INPUT, file, namedCwd("nav-ui-tools"))).toBe(plain);
  }
});

test("product non-regression: a UI folder INSIDE the project still triggers the design gate", async () => {
  for (const dir of ["components", "ui", "pages"]) {
    const v = await writeVerdict("webrun", INPUT, `${dir}/Btn.tsx`, namedCwd("plain"));
    expect(v).toContain("design skill not consulted");
  }
});

test("isUiWrite: project-relative inside the root, unchanged outside it or without a usable root", () => {
  expect(isUiWrite("Write", "/u/build-ui-tools/app/src/a.tsx", "x", "/u/build-ui-tools/app")).toBe(false);
  expect(isUiWrite("Write", "/u/app/src/components/a.tsx", "x", "/u/app")).toBe(true);
  expect(isUiWrite("Write", "/u/other/ui/a.tsx", "x", "/u/app")).toBe(true);
  expect(isUiWrite("Write", "/u/ui-tools/app/src/a.tsx", "x")).toBe(true);
  expect(isUiWrite("Write", "/u/ui-tools/app/src/a.tsx", "x", "relative/root")).toBe(true);
});

test("isShadcnWrite: same project-relative rule (.tsx / .css / .json)", () => {
  for (const f of ["a.tsx", "a.css", "a.json"]) {
    expect(isShadcnWrite("Write", `/u/ui-tools/app/src/${f}`, "/u/ui-tools/app")).toBe(false);
    expect(isShadcnWrite("Write", `/u/app/src/ui/${f}`, "/u/app")).toBe(true);
    expect(isShadcnWrite("Write", `/u/ui-tools/app/src/${f}`)).toBe(true);
  }
});

test("projectRelativePath: path == root (with and without trailing slash) keeps the absolute path", () => {
  expect(projectRelativePath("/u/ui-tools/app", "/u/ui-tools/app")).toBe("/u/ui-tools/app");
  expect(projectRelativePath("/u/ui-tools/app", "/u/ui-tools/app/")).toBe("/u/ui-tools/app");
  expect(projectRelativePath("/u/ui-tools/app/", "/u/ui-tools/app")).toBe("/u/ui-tools/app/");
  expect(isUiWrite("Write", "/u/ui-tools/app.tsx", "x", "/u/ui-tools/app.tsx")).toBe(true);
  expect(projectRelativePath("/u/app/src/a.ts", "/u/app")).toBe("src/a.ts");
});

test("isInsideRoot: equal / below / sibling `..foo` inside; `..` and other roots outside", () => {
  expect(isInsideRoot("/u/app", "/u/app")).toBe(true);
  expect(isInsideRoot("/u/app", "/u/app/src/a.ts")).toBe(true);
  expect(isInsideRoot("/u/app", "/u/app/..foo/a.ts")).toBe(true);
  expect(isInsideRoot("/u/app", "/u/other/a.ts")).toBe(false);
  expect(isInsideRoot("/u/app", "/u/a.ts")).toBe(false);
});

test("designPassNotice: the 'check-design-skill: pass' line follows the project-relative verdict", () => {
  const base = { agentId: "", tool: "Write", content: "x", url: "", phase: "pre" as const };
  const fp = "/u/ui-tools/app/src/a.tsx";
  expect(designPassNotice({ ...base, filePath: fp, projectRoot: "/u/ui-tools/app" }, "/nonexistent")).toBeNull();
  expect(designPassNotice({ ...base, filePath: fp }, "/nonexistent")?.userMessage).toContain("check-design-skill: pass");
});

test("helper: neutralTempDir names are unique, exist, digits-only after the prefix (never a UI path fragment)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const dir = neutralTempDir("fh-cxweb-wv-");
    expect(existsSync(dir)).toBe(true);
    expect(seen.has(dir)).toBe(false);
    seen.add(dir);
    const name = basename(dir);
    expect(name).toMatch(/^fh-cxweb-wv-\d+-\d+$/);
    expect(UI_FRAGMENT.test(name)).toBe(false);
  }
});

test("helper: twin probes through the neutral factory agree on .tsx for every framework query", async () => {
  for (const q of ["react useEffect", "laravel eloquent", "next app router", "weather in Paris", "swift concurrency", "cargo rust"]) {
    expect(await writeVerdict("webrun", { search_query: [{ q }] }, "App.tsx", neutralCwd)).toBe(await writeVerdict("WebSearch", { query: q }, "App.tsx", neutralCwd));
  }
});

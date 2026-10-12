import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSolidProfile, solidDetectStart } from "../src/runtime/lifecycle/solid-detect";

const root = mkdtempSync(join(tmpdir(), "solid-detect-stacks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Build a temp project dir from a `{ relPath: content }` map and detect its stack. */
function stack(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, "stack-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return detectSolidProfile(dir).type;
}
const pkg = (deps: string[]): string => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "1"])) });

test("new stacks: one fixture each", () => {
  expect(stack({ "package.json": pkg(["react", "vite"]) })).toBe("react");
  expect(stack({ "package.json": pkg(["@tanstack/react-start", "react"]) })).toBe("tanstack-start");
  expect(stack({ "package.json": pkg(["astro"]) })).toBe("astro");
  expect(stack({ "package.json": pkg(["typescript"]), "tsconfig.json": "{}" })).toBe("generic");
  expect(stack({ "package.json": pkg([]), "bun.lock": "" })).toBe("generic");
  expect(stack({ "package.json": pkg([]), "bun.lockb": "" })).toBe("generic");
  expect(stack({ "package.json": pkg([]), "bunfig.toml": "" })).toBe("generic");
  expect(stack({ "pom.xml": "" })).toBe("java");
  expect(stack({ "build.gradle": "" })).toBe("java");
  expect(stack({ "build.gradle.kts": "" })).toBe("java");
  expect(stack({ "App.csproj": "" })).toBe("csharp");
  expect(stack({ "App.sln": "" })).toBe("csharp");
  expect(stack({ "App.slnx": "" })).toBe("csharp");
  expect(stack({ Gemfile: "", Rakefile: "" })).toBe("ruby");
});

test("priority order among new stacks", () => {
  expect(stack({ "package.json": pkg(["@tanstack/react-start", "astro", "react"]) })).toBe("tanstack-start");
  expect(stack({ "package.json": pkg(["astro", "react"]) })).toBe("astro");
  expect(stack({ "package.json": pkg(["react"]), "tsconfig.json": "{}" })).toBe("react");
  expect(stack({ "package.json": pkg([]), "tsconfig.json": "{}", "pom.xml": "" })).toBe("generic");
  expect(stack({ "pom.xml": "", "App.csproj": "" })).toBe("java");
  expect(stack({ "App.csproj": "", Gemfile: "", Rakefile: "" })).toBe("csharp");
});

test("generic needs package.json + TS marker; Gemfile alone is not ruby; empty stays unknown", () => {
  expect(stack({ "package.json": pkg([]) })).toBe("unknown");
  expect(stack({ "tsconfig.json": "{}" })).toBe("unknown");
  expect(stack({ Gemfile: "" })).toBe("unknown");
  expect(stack({})).toBe("unknown");
});

/** Run solidDetectStart on a fixture; return stdout line + exported SOLID_FILE_LIMIT. */
function start(files: Record<string, string>, max?: string): { line: string; limit: string } {
  const dir = mkdtempSync(join(root, "start-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const envFile = join(dir, ".env-out");
  writeFileSync(envFile, "");
  const env: Record<string, string | undefined> = { CLAUDE_PROJECT_DIR: dir, CLAUDE_ENV_FILE: envFile, FUSE_SOLID_MAX_LINES: max };
  const line = solidDetectStart(env);
  const limit = /SOLID_FILE_LIMIT=(\S+)/.exec(readFileSync(envFile, "utf-8"))?.[1] ?? "";
  return { line, limit };
}
const gen = { "package.json": pkg([]), "tsconfig.json": "{}" };

test("SOLID_FILE_LIMIT follows FUSE_SOLID_MAX_LINES (valid), else profile default", () => {
  expect(start(gen, "200")).toEqual({ line: "SOLID: generic project (max 200 lines)", limit: "200" });
  expect(start(gen)).toEqual({ line: "SOLID: generic project (max 100 lines)", limit: "100" });
  expect(start(gen, "abc").limit).toBe("100");
  expect(start(gen, "0").limit).toBe("100");
  expect(start({ "go.mod": "" }, "250").limit).toBe("250");
  expect(start({ "Package.swift": "" }).limit).toBe("150");
  expect(start({ "Package.swift": "" }, "120").limit).toBe("120");
  expect(start({ "package.json": '{"next":1}' }).limit).toBe("150");
});

test("old stacks keep priority over new ones", () => {
  expect(stack({ "package.json": pkg(["next", "react"]), "astro.config.mjs": "" })).toBe("nextjs");
  expect(stack({ "package.json": pkg(["react"]), "go.mod": "" })).toBe("go");
  expect(stack({ "package.json": pkg([]), "tsconfig.json": "{}", "Cargo.toml": "" })).toBe("rust");
  expect(stack({ "pom.xml": "", "pyproject.toml": "" })).toBe("python");
  expect(stack({ "package.json": pkg(["react"]), "Package.swift": "" })).toBe("swift");
});

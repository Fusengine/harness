import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectClaudeMdProjectType } from "../src/policy/claude-md-context";
import { buildApexInstruction } from "../src/policy/claude-md-context";

const dirs: string[] = [];
let prev: string | undefined;
const root = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fh-dt-"));
  dirs.push(d);
  return d;
};
const pkg = (d: string, body: object): void => writeFileSync(join(d, "package.json"), JSON.stringify(body));

beforeEach(() => {
  prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prev;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("laravel + i18next (substring 'next') is laravel, not nextjs", () => {
  const d = root();
  pkg(d, { dependencies: { i18next: "1" } });
  writeFileSync(join(d, "composer.json"), "{}");
  writeFileSync(join(d, "artisan"), "#!/usr/bin/env php");
  expect(detectClaudeMdProjectType(d)).toBe("laravel");
});

test("next-themes alone is not nextjs", () => {
  const d = root();
  pkg(d, { dependencies: { "next-themes": "1" } });
  expect(detectClaudeMdProjectType(d)).not.toBe("nextjs");
});

test("peerDependencies next -> nextjs; devDependencies react -> react", () => {
  const a = root();
  pkg(a, { peerDependencies: { next: ">=14" } });
  expect(detectClaudeMdProjectType(a)).toBe("nextjs");
  const b = root();
  pkg(b, { devDependencies: { react: "19" } });
  expect(detectClaudeMdProjectType(b)).toBe("react");
});

test("tsconfig-only -> typescript; framework/laravel/swift win over tsconfig", () => {
  const a = root();
  writeFileSync(join(a, "tsconfig.json"), "{}");
  expect(detectClaudeMdProjectType(a)).toBe("typescript");
  const l = root();
  writeFileSync(join(l, "tsconfig.json"), "{}");
  writeFileSync(join(l, "composer.json"), "{}");
  writeFileSync(join(l, "artisan"), "");
  expect(detectClaudeMdProjectType(l)).toBe("laravel");
  const s = root();
  writeFileSync(join(s, "tsconfig.json"), "{}");
  writeFileSync(join(s, "Package.swift"), "");
  expect(detectClaudeMdProjectType(s)).toBe("swift");
  const r = root();
  writeFileSync(join(r, "tsconfig.json"), "{}");
  pkg(r, { dependencies: { react: "19" } });
  expect(detectClaudeMdProjectType(r)).toBe("react");
  const astro = root();
  writeFileSync(join(astro, "tsconfig.json"), "{}");
  writeFileSync(join(astro, "astro.config.mjs"), "");
  expect(detectClaudeMdProjectType(astro)).toBe("generic");
});

test("no signals and malformed package.json stay generic", () => {
  expect(detectClaudeMdProjectType(root())).toBe("generic");
  const d = root();
  writeFileSync(join(d, "package.json"), "{ not json next react");
  expect(detectClaudeMdProjectType(d)).toBe("generic");
});

test("subdir cwd with CLAUDE_PROJECT_DIR set detects the root type", () => {
  const d = root();
  pkg(d, { dependencies: { next: "16" } });
  const sub = join(d, "src", "deep");
  mkdirSync(sub, { recursive: true });
  expect(detectClaudeMdProjectType(sub)).toBe("generic");
  process.env.CLAUDE_PROJECT_DIR = d;
  expect(detectClaudeMdProjectType(sub)).toBe("nextjs");
});

test("buildApexInstruction split target uses splitTarget (never below 1)", () => {
  expect(buildApexInstruction("generic", 100)).toContain("split at 90 lines");
  expect(buildApexInstruction("generic", 5)).toContain("split at 1 lines");
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectDir } from "../util/project-dir";
import type { ProjectType } from "./detect-project";

/** Framework configs that mean a tsconfig project is NOT a plain TypeScript one. */
const FRAMEWORK_CONFIGS = [
  "astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.cjs",
  "next.config.js", "next.config.ts", "next.config.mjs",
  "nuxt.config.ts", "nuxt.config.js", "svelte.config.js", "svelte.config.ts", "angular.json",
];

/** Dependency names declared in package.json (dependencies + devDependencies + peerDependencies). */
function readDeps(dir: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const section = pkg[key];
      if (section && typeof section === "object") for (const n of Object.keys(section)) names.add(n);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Detect the project type from the project dir (`CLAUDE_PROJECT_DIR` ?? cwd):
 * package.json deps `next` → nextjs, `react` → react; else composer.json+artisan
 * → laravel; else Package.swift / *.xcodeproj → swift; else tsconfig.json with
 * no framework config → typescript; else generic.
 * @param cwd - Fallback project root to scan.
 * @returns The detected project type label.
 */
export function detectClaudeMdProjectType(cwd: string): ProjectType {
  const dir = resolveProjectDir(cwd);
  const deps = readDeps(dir);
  if (deps.has("next")) return "nextjs";
  if (deps.has("react")) return "react";
  if (existsSync(join(dir, "composer.json")) && existsSync(join(dir, "artisan"))) return "laravel";
  if (existsSync(join(dir, "Package.swift"))) return "swift";
  try {
    if (readdirSync(dir).some((f) => f.endsWith(".xcodeproj"))) return "swift";
  } catch {
    /* unreadable dir → ignore */
  }
  const framework = FRAMEWORK_CONFIGS.some((f) => existsSync(join(dir, f))) || deps.has("@tanstack/react-start");
  if (existsSync(join(dir, "tsconfig.json")) && !framework) return "typescript";
  return "generic";
}

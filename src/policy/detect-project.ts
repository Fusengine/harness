import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Project types detected from filesystem indicators. */
export type ProjectType =
  | "nextjs" | "nuxt" | "angular" | "svelte" | "vue" | "react" | "tailwind"
  | "laravel" | "rails" | "django" | "python" | "go" | "rust" | "swift"
  | "java" | "scala" | "elixir" | "ruby" | "typescript" | "generic";

/** Keywords that signal a development task (APEX trigger). */
export const DEV_KEYWORDS: RegExp =
  /\b(implement|create|build|fix|add|refactor|develop|feature|bug|update|modify|change|write|code)\b/i;

/** True when the prompt invokes the /apex command. */
export function isApexCommand(prompt: string): boolean {
  return /(?:^|\s)\/apex|\/fuse-ai-pilot:apex/i.test(prompt);
}

/** Modular architecture variants layered on top of the framework. */
export type ModularArchitecture = "fusecore" | "nextjs-modular" | null;

/**
 * Detect a project-internal modular architecture (a sub-architecture the
 * framework-level {@link detectProjectType} doesn't capture): Fusengine's
 * FuseCore (Laravel) or a `modules/`-based Next.js layout.
 */
export function detectModularArchitecture(dir: string): ModularArchitecture {
  const has = (f: string): boolean => existsSync(join(dir, f));
  if (has("FuseCore") && has("artisan")) return "fusecore";
  if (has("modules") && (has("next.config.js") || has("next.config.ts") || has("next.config.mjs"))) {
    return "nextjs-modular";
  }
  return null;
}

/**
 * Resolve the skill a detected modular architecture forces.
 *
 * Ports the Python `check-nextjs-skill.py` / `check-laravel-skill.py` gates:
 * when the project is detected on disk as a modular architecture, a specific
 * skill is required ('solid-nextjs' for nextjs-modular, 'fusecore' for
 * fusecore). Returns `null` when no modular architecture is detected.
 *
 * @param cwd - Project root directory to scan.
 * @returns The forced skill name, or `null` when none applies.
 */
export function requiredArchSkill(cwd: string): string | null {
  switch (detectModularArchitecture(cwd)) {
    case "nextjs-modular":
      return "solid-nextjs";
    case "fusecore":
      return "fusecore";
    default:
      return null;
  }
}

/** Config file names that mark a project as using Tailwind (v3 JS config or legacy). */
const TAILWIND_CONFIG_FILES = ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"];

/** True when `package.json` lists `tailwindcss` as a dep (Tailwind v4 CSS-first, no config file). */
function hasTailwindDependency(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return "tailwindcss" in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return false;
  }
}

/** Detect the project type by scanning config files in `dir`. */
export function detectProjectType(dir: string): ProjectType {
  const has = (f: string): boolean => existsSync(join(dir, f));
  if (has("next.config.js") || has("next.config.ts") || has("next.config.mjs")) return "nextjs";
  if (has("nuxt.config.ts") || has("nuxt.config.js")) return "nuxt";
  if (has("angular.json")) return "angular";
  if (has("svelte.config.js") || has("svelte.config.ts")) return "svelte";
  if (has("vite.config.ts") && has("src/App.vue")) return "vue";
  if (has("vite.config.ts") || has("vite.config.js")) return "react";
  if (TAILWIND_CONFIG_FILES.some(has) || hasTailwindDependency(dir)) return "tailwind";
  if (has("composer.json") && has("artisan")) return "laravel";
  if (has("Gemfile") && has("config/routes.rb")) return "rails";
  if (has("requirements.txt") || has("pyproject.toml") || has("setup.py")) {
    return has("manage.py") ? "django" : "python";
  }
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  if (has("Package.swift")) return "swift";
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return "java";
  if (has("build.sbt")) return "scala";
  if (has("mix.exs")) return "elixir";
  if (has("Gemfile")) return "ruby";
  return "generic";
}

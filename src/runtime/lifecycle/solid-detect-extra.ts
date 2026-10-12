import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SolidProfile } from "./solid-detect";

const profile = (type: string, ifaceDir: string): SolidProfile => ({ type, limit: 100, ifaceDir });

const TANSTACK = profile("tanstack-start", "src/interfaces");
const ASTRO = profile("astro", "src/interfaces");
const REACT = profile("react", "modules/cores/interfaces");
const GENERIC = profile("generic", "modules/cores/interfaces");
const JAVA = profile("java", "modules/core/interfaces");
const CSHARP = profile("csharp", "Contracts");
const RUBY = profile("ruby", "app/modules/core/contracts");

const GENERIC_MARKERS = ["tsconfig.json", "bun.lock", "bun.lockb", "bunfig.toml"];
const JAVA_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts"];

/** Read `package.json` text, or null when absent/unreadable. */
function readPackage(dir: string): string | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/** Stack for a `package.json` per solid-detection SKILL.md: tanstack-start > astro > react > generic. */
function detectNode(dir: string): SolidProfile | null {
  const pkg = readPackage(dir);
  if (pkg === null) return null;
  if (pkg.includes('"@tanstack/react-start"')) return TANSTACK;
  if (pkg.includes('"astro"')) return ASTRO;
  if (pkg.includes('"react"')) return REACT;
  return GENERIC_MARKERS.some((m) => existsSync(join(dir, m))) ? GENERIC : null;
}

/**
 * Detect the stacks the base table misses (tanstack-start, astro, react, generic, java,
 * csharp, ruby), in the SKILL.md priority order. Called only after the legacy chain
 * found nothing, so it can never change a previously detected stack.
 * @param dir - Project directory.
 * @returns The matching profile, or null (caller keeps `unknown`).
 */
export function detectExtraProfile(dir: string): SolidProfile | null {
  const node = detectNode(dir);
  if (node) return node;
  if (JAVA_MARKERS.some((f) => existsSync(join(dir, f)))) return JAVA;
  try {
    if (readdirSync(dir).some((e) => /\.(csproj|sln|slnx)$/.test(e))) return CSHARP;
  } catch { /* unreadable dir */ }
  if (existsSync(join(dir, "Gemfile")) && existsSync(join(dir, "Rakefile"))) return RUBY;
  return null;
}

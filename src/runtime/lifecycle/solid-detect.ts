import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_LINES_ENV_KEY } from "../../config/limits";
import { parseEnvInt } from "../../config/env";
import { detectExtraProfile } from "./solid-detect-extra";

/** A SOLID project profile: type label, per-file line limit, interface dir. */
export interface SolidProfile {
  type: string;
  limit: number;
  ifaceDir: string;
}

/** Ordered detection table (mirrors solid/scripts/detect-project.py). */
const CHECKS: { file: string; grep: string | null; profile: SolidProfile }[] = [
  { file: "package.json", grep: "next", profile: { type: "nextjs", limit: 150, ifaceDir: "modules/cores/interfaces" } },
  { file: "composer.json", grep: "laravel", profile: { type: "laravel", limit: 100, ifaceDir: "app/Contracts" } },
  { file: "go.mod", grep: null, profile: { type: "go", limit: 100, ifaceDir: "internal/interfaces" } },
  { file: "Cargo.toml", grep: null, profile: { type: "rust", limit: 100, ifaceDir: "src/traits" } },
  { file: "pyproject.toml", grep: null, profile: { type: "python", limit: 100, ifaceDir: "src/interfaces" } },
  { file: "requirements.txt", grep: null, profile: { type: "python", limit: 100, ifaceDir: "src/interfaces" } },
];

/** Detect the SOLID profile for `projectDir`, defaulting to `unknown`. */
export function detectSolidProfile(projectDir: string): SolidProfile {
  for (const { file, grep, profile } of CHECKS) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    if (grep !== null) {
      try { if (!readFileSync(path, "utf-8").includes(grep)) continue; } catch { continue; }
    }
    return profile;
  }
  if (existsSync(join(projectDir, "Package.swift"))) return { type: "swift", limit: 150, ifaceDir: "Protocols" };
  try {
    if (readdirSync(projectDir).some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"))) {
      return { type: "swift", limit: 150, ifaceDir: "Protocols" };
    }
  } catch { /* unreadable dir */ }
  return detectExtraProfile(projectDir) ?? { type: "unknown", limit: 100, ifaceDir: "" };
}

/**
 * Handle solid SessionStart: detect the profile, append SOLID_* exports to
 * `CLAUDE_ENV_FILE`, and return the `SOLID: …` stdout line (or "" for unknown).
 * Ports `solid/scripts/detect-project.py`.
 * @param env - Environment (defaults to `process.env`).
 * @returns The plain-text stdout line (possibly empty).
 */
export function solidDetectStart(env: Record<string, string | undefined> = process.env): string {
  const detected = detectSolidProfile(env.CLAUDE_PROJECT_DIR ?? ".");
  // Owner ceiling wins when set and valid (same parser as limits.ts); else the profile default.
  const profile = { ...detected, limit: parseEnvInt(env[MAX_LINES_ENV_KEY], detected.limit) };
  const envFile = env.CLAUDE_ENV_FILE ?? "";
  if (envFile) {
    try {
      appendFileSync(envFile, `export SOLID_PROJECT_TYPE=${profile.type}\nexport SOLID_FILE_LIMIT=${profile.limit}\nexport SOLID_INTERFACE_DIR=${profile.ifaceDir}\n`, "utf-8");
    } catch { /* best effort */ }
  }
  return profile.type !== "unknown" ? `SOLID: ${profile.type} project (max ${profile.limit} lines)` : "";
}

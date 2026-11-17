/**
 * @module tailwind-skill-gate
 * Standalone Tailwind base-skill gate — ports Phase 1 of the tailwindcss plugin's
 * `check-tailwind-skill.py`. A `.tsx`/`.jsx` write carrying Tailwind utility
 * classes must have consulted a base Tailwind skill (`tailwindcss-v4` or
 * `tailwindcss-utilities`) this session. Phase 2 (domain sub-skills) and Phase 3
 * (MCP research) are already enforced by {@link skillTriggerGate} (via
 * `usesTailwindUtilities`) and `docConsultedGate`, so this gate covers only the
 * base-skill gap, independent of the detected framework.
 * @packageDocumentation
 */
import type { Prompt } from "../prompt/types";
import { usesTailwindUtilities } from "./skill-triggers";
import { skillReadTarget } from "./host-skill-paths";

/** Vendored/build paths exempt (parity check-tailwind-skill.py `/(node_modules|dist|build)/`). */
const TW_EXCLUDE_RE = /(^|\/)(node_modules|dist|build)\//;
/** A read reference proving a base Tailwind skill was consulted (Phase 1). */
const TW_BASE_SKILL_RE = /skills\/(tailwindcss-v4|tailwindcss-utilities)\//;

/**
 * True when this Write/Edit is a `.tsx`/`.jsx` file carrying Tailwind utility
 * classes, outside vendored dirs — the trigger condition of Phase 1.
 * @param tool - the tool name.
 * @param filePath - the file being written.
 * @param content - the written content.
 */
export function isTailwindWrite(tool: string, filePath: string, content: string): boolean {
  if (tool !== "Write" && tool !== "Edit") return false;
  if (TW_EXCLUDE_RE.test(filePath)) return false;
  return usesTailwindUtilities(filePath, content);
}

/** True when `tailwindcss-v4` or `tailwindcss-utilities` was read this session (Phase 1 base skill). */
export function tailwindBaseSkillRead(refsRead: readonly string[]): boolean {
  return refsRead.some((p) => TW_BASE_SKILL_RE.test(p));
}

/**
 * Gate a Tailwind-scoped write: block until a base Tailwind skill is read
 * (parity check-tailwind-skill.py Phase 1). Returns `null` when out of scope
 * or already satisfied.
 * @param tool - the tool name.
 * @param filePath - the file being written.
 * @param content - the written content.
 * @param refsRead - in-session read reference paths.
 * @param hostId - Running host id (printed skill paths are that host's own; absent = Claude Code, unchanged).
 */
export function tailwindSkillGate(
  tool: string,
  filePath: string,
  content: string,
  refsRead: readonly string[],
  hostId?: string,
): Prompt | null {
  if (!isTailwindWrite(tool, filePath, content)) return null;
  if (tailwindBaseSkillRead(refsRead)) return null;
  return {
    kind: "block",
    title: "Tailwind CSS skill",
    reason:
      "BLOCKED: Tailwind skill not consulted. Read tailwindcss-v4/SKILL.md or tailwindcss-utilities/SKILL.md, or use mcp__context7__query-docs (topic: tailwindcss), then retry.",
    actions: [`Read ${skillReadTarget("tailwindcss-v4", hostId)} or ${skillReadTarget("tailwindcss-utilities", hostId)}`],
  };
}

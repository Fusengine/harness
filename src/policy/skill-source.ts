/**
 * Framework -> SKILL.md doc source for the APEX Check-1 non-routed deny —
 * parity with the Python plugin's enforce-helpers.ts `getSkillSource()`
 * (10-entry map, fallback "mcp__context7__query-docs"). The map is ported
 * faithfully as skill NAMES only: disk paths are resolved DYNAMICALLY via
 * {@link resolveSkillPath} (proprietary rule — no static path table; installed
 * plugin dir names differ from upstream's `react-expert/...`, and a hardcoded
 * table drifts from what is actually installed).
 */
import { resolveSkillPath } from "./skill-path";
import { existingSkillPath, isNonClaudeHost } from "./host-skill-paths";

/**
 * Fallback doc source when no SKILL.md can be promised: the consigne to query
 * context7 (a TOOL name, not a path) — parity enforce-helpers.ts:51.
 */
export const CONTEXT7_SOURCE = "mcp__context7__query-docs";

/**
 * Framework -> sub-skill dir name, faithful to the Python
 * `getSkillSource` map (enforce-helpers.ts:39-50, all 10 entries).
 */
const SKILL_NAMES: Record<string, string> = {
  react: "react-19",
  nextjs: "nextjs-16",
  swift: "swiftui-components",
  laravel: "laravel-eloquent",
  tailwind: "tailwindcss-v4",
  generic: "solid-generic",
  java: "solid-java",
  go: "solid-go",
  ruby: "solid-ruby",
  rust: "solid-rust",
};

/**
 * The doc source a Check-1 deny may promise for `framework` (parity
 * `getSkillSource`): the REAL installed SKILL.md absolute path when it exists
 * on disk, else {@link CONTEXT7_SOURCE}. `resolveSkillPath` returns a
 * `/SKILL.md`-suffixed path ONLY on an `existsSync` hit; its
 * `${PLUGINS_DIR}/<name>` not-found fallback (no marketplace installed, or a
 * mapped skill absent on disk — e.g. upstream's `swiftui-components`) is
 * converted to the context7 consigne here, because a deny must never promise
 * a nonexistent path (every option a deny offers must actually unblock).
 * @param framework - Detected framework (the `detectFramework()` domain).
 * @param pluginsDirOverride - Marketplace plugins dir override (tests).
 * @param hostId - Running host id; a non-Claude host resolves in its own install first, then the real discovered path.
 */
export function getSkillSource(framework: string, pluginsDirOverride?: string, hostId?: string): string {
  const name = SKILL_NAMES[framework];
  if (!name) return CONTEXT7_SOURCE;
  // A non-Claude host: its OWN installed skill, else the real discovered one on disk, else context7.
  if (isNonClaudeHost(hostId)) return existingSkillPath(name, hostId as string, pluginsDirOverride) ?? CONTEXT7_SOURCE;
  const path = resolveSkillPath(name, pluginsDirOverride);
  return path.endsWith("/SKILL.md") ? path : CONTEXT7_SOURCE;
}

/**
 * Content → sub-skill consultation gate, ported from the fusengine Python
 * `*_skill_triggers.py` (react/nextjs/laravel) + `check_skill_common.py`
 * `specific_skill_consulted`. Maps written-code API patterns to a required
 * sub-skill and blocks when its `skills/<name>/` path was not read in-session.
 */
import type { Prompt } from "../prompt/types";
import { CASE_SENSITIVE_FRAMEWORKS, SKILL_TRIGGERS } from "./skill-trigger-patterns";
import { isShadcnProject } from "./shadcn-project";
import { skillReadTarget } from "./host-skill-paths";
import { isReleaseMetadataPath } from "./release-metadata-path";

export { SKILL_TRIGGERS } from "./skill-trigger-patterns";

/**
 * Detect which sub-skills the written `content` requires for a `framework`.
 * Faithful to the Python `detect_required_skills`: first matching pattern per
 * skill wins. Most frameworks match case-insensitively (source `re.IGNORECASE`);
 * `swift` matches case-sensitively (see {@link CASE_SENSITIVE_FRAMEWORKS}).
 * @param framework - "react" | "nextjs" | "laravel" | "swift".
 * @param content - the code being written.
 * @returns required sub-skill names (empty when framework unknown / no match).
 */
export function detectRequiredSkills(framework: string, content: string): string[] {
  const groups = SKILL_TRIGGERS[framework];
  if (!groups) return [];
  const flags = CASE_SENSITIVE_FRAMEWORKS.has(framework) ? "" : "i";
  const required: string[] = [];
  for (const [skill, patterns] of Object.entries(groups)) {
    if (patterns.some((p) => new RegExp(p, flags).test(content))) required.push(skill);
  }
  return required;
}

/**
 * `.tsx`/`.jsx` — the only extensions `check-tailwind-skill.py` actually gates
 * (its regex also lists `.css`/`.html`, but both hit an early return right
 * after, in the Python source).
 */
const TAILWIND_FILE = /\.(tsx|jsx)$/;

/** Ported verbatim from `check-tailwind-skill.py`'s `TW_PATTERN`. */
const TAILWIND_CONTENT = /(className|class).*['"].*\b(flex|grid|p-|m-|w-|h-|text-|bg-|border-)/;

/**
 * True when `filePath`/`content` match the Python Tailwind gate's trigger
 * condition. React/Next.js components embed Tailwind utility classes in
 * `className` — this check fires IN ADDITION TO the primary framework gate,
 * never instead of it: {@link detectFramework} keeps returning "react"/
 * "nextjs" for these files (framework SOLID rules stay correct).
 */
export function usesTailwindUtilities(filePath: string, content: string): boolean {
  return TAILWIND_FILE.test(filePath) && TAILWIND_CONTENT.test(content);
}

/**
 * Block when a required sub-skill's `skills/<name>/` path is absent from
 * `refsRead`. Mirrors `specific_skill_consulted`, which confirms a skill was
 * read by checking the tracking file contains `skills/<name>/`.
 * @param framework - "react" | "nextjs" | "laravel".
 * @param content - the code being written.
 * @param refsRead - in-session read reference paths.
 * @param forcedSkill - a skill the detected modular architecture forces (optional).
 * @param cwd - project root; when set and not a shadcn project, `*-shadcn`
 *   requirements are skipped (ports the Python `is_shadcn_project` filter).
 * @param filePath - the file being written; when it's a `.tsx`/`.jsx` file
 *   with Tailwind utility classes in `className`, the "tailwind" domain
 *   skills are merged in alongside `framework`'s own (ports the separate
 *   `check-tailwind-skill.py` gate, independent of react/nextjs).
 * @param hostId - Running host id: the printed skill paths are that host's own
 *   install (else a real discovered path, else neutral wording); absent = Claude Code, unchanged.
 * @returns a `block` Prompt naming the missing sub-skills, or `null` when satisfied.
 */
export function skillTriggerGate(
  framework: string,
  content: string,
  refsRead: readonly string[],
  forcedSkill?: string | null,
  cwd?: string,
  filePath?: string,
  hostId?: string,
): Prompt | null {
  // Release metadata (plugin/marketplace manifest, changelog) carries no framework API: no skill applies.
  if (filePath && isReleaseMetadataPath(filePath)) return null;
  // Phase 1.5 parity (check-laravel-skill.py:57-62): a forced FuseCore skill is
  // denied on its own, BEFORE domain sub-skills — never merged into their message.
  if (forcedSkill === "fusecore" && !refsRead.some((r) => r.includes("skills/fusecore/"))) {
    return {
      kind: "block",
      title: "FuseCore skill not consulted",
      reason:
        "BLOCKED: FuseCore project detected. Read the FuseCore skill before writing code in FuseCore modules.",
      actions: [`Read ${skillReadTarget("fusecore", hostId)}`],
    };
  }
  let required = detectRequiredSkills(framework, content);
  if (framework !== "tailwind" && filePath && usesTailwindUtilities(filePath, content)) {
    required = [...required, ...detectRequiredSkills("tailwind", content)];
  }
  if (forcedSkill && !required.includes(forcedSkill)) required.push(forcedSkill);
  if (cwd && !isShadcnProject(cwd)) required = required.filter((s) => !s.endsWith("-shadcn"));
  const missing = required.filter(
    (s) => !refsRead.some((r) => r.includes(`skills/${s}/`)),
  );
  if (missing.length === 0) return null;
  return {
    kind: "block",
    title: "Required sub-skill not consulted",
    reason:
      `${framework}: code uses APIs covered by ${missing.join(", ")} ` +
      "but its skill reference was not read this session.",
    actions: missing.map((s) => `Read ${skillReadTarget(s, hostId)}`),
  };
}

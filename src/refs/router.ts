import { globToRe } from "./frontmatter";
import type { RefMeta, ScoredRef, RouteResult } from "./types";

/**
 * Score references against a file edit (pure) — flat scoring, parity with the
 * Python `ref_router._score_ref` (comma-split, single award per category):
 * +10 once if ANY `applies-to` glob matches, +5 once if ANY `trigger-on-edit`
 * fragment (trailing `/` stripped) is a substring of the path, +1 per keyword.
 */
export function scoreReferences(refs: RefMeta[], filePath: string, content: string): ScoredRef[] {
  const scored: ScoredRef[] = [];
  const hay = `${filePath} ${content}`.toLowerCase();
  for (const meta of refs) {
    let score = 0;
    if (meta.appliesTo?.split(",").some((g) => g.trim() && globToRe(g.trim()).test(filePath))) score += 10;
    if (meta.triggerOnEdit?.split(",").some((f) => { const t = f.trim().replace(/\/+$/, ""); return t && filePath.includes(t); })) score += 5;
    if (meta.keywords) {
      for (const kw of meta.keywords.split(",")) {
        const k = kw.trim().toLowerCase();
        if (k && hay.includes(k)) score += 1;
      }
    }
    if (score > 0) scored.push({ meta, score });
  }
  return scored;
}

/** Detected framework -> its own `solid-*` skill dir when the name is not `solid-<framework>`. */
const OWN_SKILL_ALIAS: Record<string, string> = { laravel: "solid-php" };
/** Detected "frameworks" with no dedicated solid skill (never prefer one). */
const NO_OWN_SKILL = new Set(["", "generic", "tailwind"]);

/**
 * The detected framework's own SOLID skill dir name (`solid-tanstack-start`,
 * `solid-nextjs`, `solid-php` for laravel, ...), or `undefined` for a framework
 * without one (generic, tailwind). Whether it is INSTALLED is decided by the refs.
 * @param framework - Detected framework (`detectFramework()` domain).
 */
export function frameworkSkill(framework: string): string | undefined {
  if (NO_OWN_SKILL.has(framework)) return undefined;
  return OWN_SKILL_ALIAS[framework] ?? `solid-${framework}`;
}

/**
 * Route references for a file edit: top-2 required + next-2 optional, ensuring a
 * `principle` and a `template` appear in the top 4. Returns null when nothing scores.
 */
export function routeReferences(
  refs: RefMeta[],
  filePath: string,
  content: string,
  skillPath = "",
  framework = "",
): RouteResult | null {
  let scored = scoreReferences(refs, filePath, content);
  // Framework-aware: when the detected framework has its OWN solid skill and one of
  // its refs scores for this edit, only that skill's refs are routed (a generic
  // `**/*.tsx` glob of another skill must not outrank it). No own ref scored → the
  // flat cross-skill scoring below is unchanged.
  const own = frameworkSkill(framework);
  if (own) {
    const ownScored = scored.filter((s) => s.meta.filePath.includes(`/skills/${own}/`));
    if (ownScored.length) scored = ownScored;
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const hoist = (level: string): void => {
    if (scored.slice(0, 4).some((r) => r.meta.level === level)) return;
    const found = scored.find((r) => r.meta.level === level);
    if (found) {
      scored.splice(scored.indexOf(found), 1);
      scored.splice(3, 0, found);
    }
  };
  hoist("principle");
  hoist("template");
  return { required: scored.slice(0, 2), optional: scored.slice(2, 4), skillPath: skillPath || skillPathFromRef(scored[0]?.meta.filePath ?? "") };
}

/**
 * Derive a skill's `SKILL.md` path from one of its `references/` file paths
 * (`<skill>/references/...` → `<skill>/SKILL.md`), matching the on-disk skill
 * layout {@link discoverRefs} walks. Returns "" when the ref's path doesn't
 * follow that layout (e.g. ad-hoc refs dirs used in tests).
 */
function skillPathFromRef(refFilePath: string): string {
  const i = refFilePath.indexOf("/references/");
  return i === -1 ? "" : `${refFilePath.slice(0, i)}/SKILL.md`;
}

import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverRefs, hostSkillParents, listSkillRefDirs } from "./discover";
import { loadableRefCount } from "./loader";

/** True when EVERY entry of a refs source lies under `<home>/.claude/` (the Claude Code home tree). */
function underHomeClaude(source: string, home: string): boolean {
  const root = resolve(home, ".claude");
  const entries = source.split(delimiter).filter(Boolean);
  return entries.length > 0 && entries.every((e) => {
    const rel = relative(root, resolve(e));
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}

/** Skill key of a refs dir: `<skill>/references` -> `<skill>`, any other dir -> its own name. */
const keyOfDir = (dir: string): string => (basename(dir) === "references" ? basename(dirname(dir)) : basename(dir));

/**
 * The refs source a hook invocation uses. BASE is exactly what the original code
 * computed: `FUSE_HARNESS_REFS` if set, else shared discovery with NO host id. Claude
 * Code (no id / `claude-code`) and any source not entirely under `<home>/.claude/`
 * (a custom or the host's own tree) return BASE unchanged.
 *
 * A non-Claude host whose source is entirely under `<home>/.claude/` (the inherited /
 * shared Claude refs) substitutes, PER SKILL KEY, its own installed refs dir, and only
 * when BOTH dirs actually load: the base dir for that key loads >= 1 ref and the host
 * dir loads >= 1 ref with the real loader steps, never throwing ({@link loadableRefCount}).
 * Every other key keeps its base dir and no base key is ever dropped or added, so the
 * result has the same keys as base, each loadable exactly when base's was: the gate's
 * required skill set and verdict cannot be weaker than base's by construction.
 * @param home - The real home: BASE discovery and the `<home>/.claude` check use it exactly as before.
 * @param hostHomeDir - Home of the host-owned lookup only (`hostHome()`, i.e. the `FUSE_HARNESS_HOME` override); defaults to `home`.
 * @param cwd - Current project dir.
 * @param marketplaces - Marketplace allowlist.
 * @param id - Running host id (omitted = Claude Code).
 * @param env - Environment; defaults to `process.env`.
 * @returns A `path.delimiter`-joined dirs list, or `undefined` when none.
 */
export function refsDirFor(home: string, cwd: string, marketplaces: string[], id?: string, env: Record<string, string | undefined> = process.env, hostHomeDir: string = home): string | undefined {
  const base = env.FUSE_HARNESS_REFS || discoverRefs(home, cwd, marketplaces) || undefined;
  if (!base || !id || id === "claude-code" || !underHomeClaude(base, home)) return base;
  const own = new Map<string, string>();
  for (const parent of hostSkillParents(id, hostHomeDir, env)) {
    for (const dir of listSkillRefDirs(parent)) {
      const key = keyOfDir(dir);
      if (!own.has(key) && existsSync(join(dir)) && loadableRefCount(dir) > 0) own.set(key, dir);
    }
  }
  const out = base.split(delimiter).filter(Boolean).map((dir) => {
    const mine = own.get(keyOfDir(dir));
    return mine && loadableRefCount(dir) > 0 ? mine : dir;
  });
  return [...new Set(out)].join(delimiter);
}

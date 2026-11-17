import { existsSync, readdirSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { HOME_DIR } from "../config/dotenv";
import type { HarnessId } from "../detect/interfaces/types";

/** Env var that relocates a host's home dir (`$CODEX_HOME`, `$KIMI_CODE_HOME`). */
const HOST_HOME_ENV: Partial<Record<string, string>> = { codex: "CODEX_HOME", kimi: "KIMI_CODE_HOME" };

/** Immediate subdirectory names of `p`, or `[]` when it is missing/inaccessible. */
function subdirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const VERSION_DIR = /^v?\d+(\.\d+)*([-+].*)?$/;

/** Numeric dotted-segment compare of two version dir names (`1.0.100` > `1.0.39`). */
function compareVersions(a: string, b: string): number {
  const seg = (v: string): number[] => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map(Number);
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Directory mtime (ms), 0 when unreadable. */
function mtimeOf(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * Order the sibling dirs `names` of `dir`: HIGHEST VERSION FIRST when every name
 * is a version (`1.0.100` before `1.0.39`, not readdir order); MOST RECENTLY
 * MODIFIED first when they are install snapshots (hash-named dirs such as
 * Cursor's `plugins/cache/<mkt>/<plugin>/<hash>/`, recognised by holding a
 * `skills` dir); any other set is returned unchanged.
 */
function orderSiblings(dir: string, names: string[]): string[] {
  if (names.length < 2) return names;
  if (names.every((n) => VERSION_DIR.test(n))) return [...names].sort((a, b) => compareVersions(b, a));
  if (names.some((n) => existsSync(join(dir, n, "skills")))) return [...names].sort((a, b) => mtimeOf(join(dir, b)) - mtimeOf(join(dir, a)));
  return names;
}

/**
 * The running host's OWN `skills/` parent dirs, resolved from where that host
 * installed its plugins (its home dir, `$CODEX_HOME`/`$KIMI_CODE_HOME` aware):
 * `<host home>/skills` and every `skills` dir found at most 5 levels under
 * `<host home>/plugins` (Codex `plugins/cache/<mkt>/<plugin>/<ver>/skills`,
 * Cursor `plugins/{cache,local}/...`). Any marketplace name counts: it is the
 * host's own install. Empty for Claude Code (its layout is {@link skillParents}).
 */
export function hostSkillParents(id: string, home: string, env: Record<string, string | undefined>): string[] {
  const seg = HOME_DIR[id as HarnessId];
  if (!seg || id === "claude-code") return [];
  const hostHome = env[HOST_HOME_ENV[id] ?? ""] || join(home, seg);
  const out = [join(hostHome, "skills")];
  const walk = (dir: string, depth: number): void => {
    for (const name of orderSiblings(dir, subdirs(dir))) {
      if (name === "node_modules") continue;
      const next = join(dir, name);
      if (name === "skills") out.push(next);
      else if (depth < 5) walk(next, depth + 1);
    }
  };
  walk(join(hostHome, "plugins"), 1);
  return out;
}

/**
 * Every `skills/` parent dir across the Open-Agent-Skills layouts
 * (agentskills.io) of Claude Code, Codex and Cursor: the standalone skill roots
 * (`<base>/{.claude,.codex,.cursor,.agents}/skills` + `/etc/codex/skills`) plus
 * installed-plugin roots (`<plugin>/skills` under the Claude marketplace and the
 * Claude/Codex version caches). Shallow `readdir` only — no deep walk — so it is
 * cheap enough to run on every hook.
 */
function skillParents(home: string, cwd: string, marketplaces: string[]): string[] {
  const out: string[] = [];
  for (const base of [cwd, home]) {
    for (const tool of [".claude", ".codex", ".cursor", ".agents"]) out.push(join(base, tool, "skills"));
  }
  out.push(join("/etc", "codex", "skills"));
  // Claude marketplace: <mkt>/plugins/<plugin>/skills.
  const mktRoot = join(home, ".claude", "plugins", "marketplaces");
  for (const mkt of subdirs(mktRoot)) {
    if (!marketplaces.includes(mkt)) continue;
    const pluginsDir = join(mktRoot, mkt, "plugins");
    for (const plugin of subdirs(pluginsDir)) out.push(join(pluginsDir, plugin, "skills"));
  }
  // Version caches: <cache>/<mkt>/<plugin>/<version>/skills.
  for (const cacheRoot of [join(home, ".claude", "plugins", "cache"), join(home, ".codex", "plugins", "cache")]) {
    for (const mkt of subdirs(cacheRoot)) {
      if (!marketplaces.includes(mkt)) continue;
      for (const plugin of subdirs(join(cacheRoot, mkt))) {
        for (const ver of orderSiblings(join(cacheRoot, mkt, plugin), subdirs(join(cacheRoot, mkt, plugin)))) out.push(join(cacheRoot, mkt, plugin, ver, "skills"));
      }
    }
  }
  return out;
}

/**
 * Auto-discover SOLID reference dirs (`<skill>/references` for every `solid-*`
 * skill) across the Claude/Codex/Cursor skill layouts — the fallback used when
 * `FUSE_HARNESS_REFS` is unset. Deduped by skill name (first source wins, so a
 * marketplace skill shadows its version-cache copy). Returns a path-delimiter
 * list, or `""` when none is found — with no refs the SOLID-read gate stays off.
 * @param home - User home dir (`os.homedir()`).
 * @param cwd - Current project dir (`process.cwd()`).
 * @param marketplaces - Allowlist of marketplace names to scan (env
 *   `FUSE_HARNESS_MARKETPLACES`, default `["fusengine-plugins"]`); a marketplace
 *   absent from disk simply contributes nothing. Standalone
 *   `.claude`/`.codex`/`.cursor`/`.agents` skill roots are always scanned.
 * @param id - Running host id. A non-Claude host scans its OWN install first
 *   ({@link hostSkillParents}) so the paths the gates print are that host's
 *   own; the shared layouts stay as fallback so a host without its own
 *   `solid-*` skills keeps the gate on. Omitted / `claude-code`: unchanged.
 * @param env - Environment (host-home overrides); defaults to `process.env`.
 * @returns A `path.delimiter`-joined list of `references` dirs, or `""`.
 */
export function discoverRefs(home: string, cwd: string, marketplaces: string[], id?: string, env: Record<string, string | undefined> = process.env): string {
  const bySkill = new Map<string, string>();
  const parents = [...(id ? hostSkillParents(id, home, env) : []), ...skillParents(home, cwd, marketplaces)];
  for (const parent of parents) {
    for (const skill of subdirs(parent)) {
      if (!skill.startsWith("solid-") || bySkill.has(skill)) continue;
      if (subdirs(join(parent, skill)).includes("references")) bySkill.set(skill, join(parent, skill, "references"));
    }
  }
  return [...bySkill.values()].join(delimiter);
}

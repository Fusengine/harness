/**
 * Host-aware skill paths for model-facing gate messages. Rule: a path is printed
 * only if it EXISTS on disk, and a required ref is never hidden. For a non-Claude
 * host the path is that host's OWN install when it has the skill (resolved at
 * runtime from its home / plugin cache), else the real discovered path that
 * exists (even under `~/.claude`: the deny must stay clearable), else neutral
 * wording. Claude Code keeps its historical text.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostSkillParents } from "../refs/discover";
import { resolveSkillPath } from "./skill-path";

/** True when `hostId` is a non-Claude host (an omitted id means Claude Code: unchanged behaviour). */
export function isNonClaudeHost(hostId: string | undefined): boolean {
  return !!hostId && hostId !== "claude-code";
}

/**
 * The host whose own names and paths model-facing messages should use. Cursor also
 * runs Claude Code hooks from `~/.claude/settings.json` (third-party hooks), which
 * invoke the harness as `claude-code`. Cursor documents `CURSOR_VERSION` as always
 * present in its hook processes (cursor.com/docs/hooks, "Environment Variables"),
 * while real Claude Code sets `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`; so a
 * `claude-code` invocation with `CURSOR_VERSION` and NO Claude Code marker is
 * rendered as `cursor`. Only message text changes: verdicts and the response
 * wire format keep using the invocation id.
 * @param id - The harness id the CLI was invoked with.
 * @param env - Environment; defaults to `process.env`.
 */
export function messageHost(id: string, env: Record<string, string | undefined> = process.env): string {
  if (id !== "claude-code") return id;
  const underCursor = !!env.CURSOR_VERSION?.trim() && !env.CLAUDECODE?.trim() && !env.CLAUDE_CODE_ENTRYPOINT?.trim();
  return underCursor ? "cursor" : id;
}

/** What a routed-refs deny prints, already adapted to the running host. */
export interface HostRoutedPaths {
  optional: string[];
  /** `null` = omit the "Full skill:" line. */
  skillPath: string | null;
  actions: string[];
}

/**
 * Adapt a routed-refs deny to the running host. Claude Code: returned as-is
 * (message byte-identical). Another host: required refs and Optional entries are
 * always kept (the SOLID-read gate requires exactly those files), and the
 * "Full skill:" line is printed only when that `SKILL.md` exists.
 * @param routed - Routed refs (`optional` metas + `skillPath`).
 * @param ctx - `hostId`.
 * @param required - Absolute paths the model must Read (required / still missing).
 */
export function hostRoutedPaths(routed: { optional: { meta: { filePath: string } }[]; skillPath: string }, ctx: { hostId?: string }, required: string[] = []): HostRoutedPaths {
  const optional = routed.optional.map((r) => r.meta.filePath);
  if (!isNonClaudeHost(ctx.hostId)) return { optional, skillPath: routed.skillPath, actions: required };
  return { optional, skillPath: routed.skillPath && existsSync(routed.skillPath) ? routed.skillPath : null, actions: required };
}

const cache = new Map<string, string | null>();

/**
 * The home dir host skill installs are looked up under: `os.homedir()`, or the
 * `FUSE_HARNESS_HOME` override (tests point it at a temp dir; Bun caches
 * `os.homedir()`, so changing `HOME` in-process has no effect).
 * @param env - Environment; defaults to `process.env`.
 */
export function hostHome(env: Record<string, string | undefined> = process.env): string {
  return env.FUSE_HARNESS_HOME?.trim() || homedir();
}

/**
 * The running non-Claude host's own installed `skills/<name>/SKILL.md`, or null.
 * Bounded (shallow host-skill walk) and memoised per process.
 * @param skillName - Skill dir name (e.g. "solid-react").
 * @param hostId - Running host id.
 * @param home - Home dir (tests inject a fake host home).
 * @param env - Environment (host-home overrides).
 */
export function hostSkillPath(skillName: string, hostId: string, home: string = hostHome(), env: Record<string, string | undefined> = process.env): string | null {
  const key = `${hostId}\0${home}\0${skillName}\0${env.CODEX_HOME ?? ""}\0${env.KIMI_CODE_HOME ?? ""}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: string | null = null;
  for (const parent of hostSkillParents(hostId, home, env)) {
    const candidate = join(parent, skillName, "SKILL.md");
    if (existsSync(candidate)) { found = candidate; break; }
  }
  cache.set(key, found);
  return found;
}

/**
 * Real `SKILL.md` to point a non-Claude host at: its own install first, else the
 * discovered marketplace path when it exists on disk, else null (never a phantom path).
 * @param skillName - Skill dir name.
 * @param hostId - Running host id.
 * @param pluginsDirOverride - Marketplace plugins dir override (tests).
 */
export function existingSkillPath(skillName: string, hostId: string, pluginsDirOverride?: string): string | null {
  const own = hostSkillPath(skillName, hostId);
  if (own) return own;
  const shared = resolveSkillPath(skillName, pluginsDirOverride);
  return shared.endsWith("/SKILL.md") && existsSync(shared) ? shared : null;
}

/**
 * The SOLID skill DIRECTORY (with trailing `/`) for a `SOLID_REF` entry such as
 * `react-expert/skills/solid-react/`, resolved for a non-Claude host, or null.
 * @param ref - `SOLID_REF` value (`<plugin>/skills/<skill>/`).
 * @param hostId - Running host id.
 */
export function solidSkillDir(ref: string, hostId: string): string | null {
  const last = ref.split("/").filter(Boolean).pop();
  // `SOLID_REF` falls back to the phantom `generic/` dir: the real skill is `solid-generic`.
  const name = last === "generic" ? "solid-generic" : last;
  const p = name ? existingSkillPath(name, hostId) : null;
  return p ? `${dirname(p)}/` : null;
}

/**
 * What a "Read <skill>" action should print for `skillName`. Claude Code (or no
 * host): `resolveSkillPath`, byte-identical to before. A non-Claude host: its own
 * install's `SKILL.md`, else the real discovered one on disk, else neutral wording
 * (never a phantom path). A read of any copy clears the gates (they credit the
 * `skills/<name>/` segment, not an exact path).
 * @param skillName - Skill dir name (e.g. "react-19").
 * @param hostId - Running host id (undefined = Claude Code).
 */
export function skillReadTarget(skillName: string, hostId?: string): string {
  if (!isNonClaudeHost(hostId)) return resolveSkillPath(skillName);
  return existingSkillPath(skillName, hostId as string) ?? `the ${skillName} skill in your own skills directory`;
}

/**
 * The design-expert `skills/` root to cite in design refusals: Claude Code keeps
 * the historical `<PLUGINS_DIR>/design-expert/skills`; a non-Claude host gets the
 * dir holding its own installed `design-system` skill, or null (neutral wording).
 * @param hostId - Running host id (undefined = Claude Code).
 * @param claudeRoot - The historical Claude path.
 */
export function designSkillsRoot(hostId: string | undefined, claudeRoot: string): string | null {
  if (!isNonClaudeHost(hostId)) return claudeRoot;
  const p = existingSkillPath("design-system", hostId as string);
  return p ? dirname(dirname(p)) : null;
}

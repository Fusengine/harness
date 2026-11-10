import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isPlainComponent } from "./bash-write-scratchpad-target";

/** Overrides for tests: temp roots (default: the system temp dirs) and project dirs (default: CLAUDE_PROJECT_DIR + cwd; no narrowing when CLAUDE_PROJECT_DIR is unset). */
export interface TempDeleteOptions {
  /** Absolute dirs whose strict children count as temp; replaces the built-in `/var/tmp` + `/var/folders/x/y/T` forms. */
  roots?: readonly string[];
  /** Project dirs; the narrowing is off when any of them is inside a temp dir. */
  projectDirs?: readonly string[];
}

/** Built-in temp roots (macOS `/private` forms included): `/var/tmp` and the per-user `/var/folders/<x>/<y>/T`; `<x>`/`<y>` are never all dots (no `..` escape). */
const SYSTEM_ROOT = /^(?:\/private)?(?:\/var\/tmp|\/var\/folders\/(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+\/)[A-Za-z0-9_.-]+\/T)(?=\/|$)/;
/** The whole command: `rm`, short flags, then targets; nothing else (no quote, expansion, glob, separator or redirect can occur). */
const SIMPLE_RM = /^rm((?:[ \t]+-[A-Za-z]+)+)((?:[ \t]+[A-Za-z0-9_./-]+)+)$/;

/** Root prefix of `path` (built-in forms or the injected list), or null. */
function rootOf(path: string, roots: readonly string[] | undefined): string | null {
  if (!roots) return SYSTEM_ROOT.exec(path)?.[0] ?? null;
  return roots.find((r) => path === r || path.startsWith(`${r}/`)) ?? null;
}

/** True when `path` is the temp root itself or anything under it. */
function insideTemp(path: string, roots: readonly string[] | undefined): boolean {
  return rootOf(path, roots) !== null;
}

/** Default project dirs (CLAUDE_PROJECT_DIR + process cwd), resolved through symlinks when they exist; null when CLAUDE_PROJECT_DIR is unset (no narrowing). */
function defaultProjectDirs(): string[] | null {
  const project = process.env["CLAUDE_PROJECT_DIR"];
  if (!project) return null;
  return [process.cwd(), project].map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
}

/**
 * Lexical + physical check of one target: a normalized absolute path strictly
 * below a temp root, plain components only, and no existing component (from the
 * first one below the root) is a symlink. A missing component ends the walk.
 */
function targetIsInside(target: string, roots: readonly string[] | undefined): boolean {
  const root = rootOf(target, roots);
  if (root === null || target === root) return false;
  const rest = target.slice(root.length + 1);
  const segments = (rest.endsWith("/") ? rest.slice(0, -1) : rest).split("/");
  if (segments.some((s) => !isPlainComponent(s))) return false;
  // Every component from "/" down (root levels included) is lstat'ed; the macOS system link /var -> private/var is the only link allowed.
  const parts = [...root.slice(1).split("/"), ...segments];
  let cur = "";
  for (const [i, seg] of parts.entries()) {
    cur = `${cur}/${seg}`;
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        if (cur !== "/var" || readlinkSync(cur) !== "private/var") return false;
      } else if (i < parts.length - 1 && !st.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

/**
 * True when the command is exactly one `rm <flags> <targets>` whose every target is a
 * literal absolute path strictly inside a system temp dir (`/var/tmp/x`,
 * `/var/folders/<x>/<y>/T/x`, `/private/...` forms). The caller then lets the generic
 * `rm` ask decide instead of the CRITICAL system-directory block. Anything else
 * (extra words, separators, quotes, expansions, `..`, symlinks, temp roots themselves,
 * a project dir inside a temp dir) returns false, i.e. keeps the old verdict.
 * @param cmd - Raw Bash command.
 * @param options - Test overrides (roots, project dirs).
 * @returns True when the narrowing applies.
 */
export function isTempOnlyDelete(cmd: string, options: TempDeleteOptions = {}): boolean {
  const m = SIMPLE_RM.exec(cmd.trim());
  if (!m) return false;
  const targets = (m[2] ?? "").trim().split(/[ \t]+/);
  const { roots } = options;
  if (!targets.every((t) => targetIsInside(t, roots))) return false;
  const dirs = options.projectDirs ?? defaultProjectDirs();
  return dirs !== null && !dirs.some((d) => insideTemp(d, roots));
}

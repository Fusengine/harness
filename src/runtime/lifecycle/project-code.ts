import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isCodeFile } from "./code-extensions";
import { isClaudeScratchpad } from "./scratchpad-path";

/** `realpath` of the deepest existing ancestor + the not-yet-existing tail (macOS `/var` -> `/private/var`, symlinked roots). */
function canonical(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** True when `path` equals `root` or lies below it (same path flavour: both lexical or both real). */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** macOS per-user temp dir (`/var/folders/xx/yyyy/T`, with or without the `/private` prefix). */
const MAC_TMP = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/;
/** Fixed temp roots (`/tmp` and `/private/tmp` are the same place on macOS). */
const FIXED_TMP = ["/tmp", "/private/tmp"];

/** Whether an already-resolved path lies in a temp area (os.tmpdir(), $TMPDIR, /tmp, /private/tmp, macOS /var/folders/*\/T). */
function inTempArea(abs: string, env: NodeJS.ProcessEnv): boolean {
  if (MAC_TMP.test(abs)) return true;
  const areas = [...FIXED_TMP, tmpdir(), ...(env.TMPDIR ? [env.TMPDIR] : [])];
  return areas.some((a) => isInside(resolve(a), abs) || isInside(canonical(a), abs));
}

/**
 * The ONE "is this project code?" predicate shared by every lifecycle guard
 * (SubagentStop sniper demand, Stop/TaskCompleted receipt gate + SOLID check,
 * the PostToolUse edit stamp). Conservative by construction: everything keeps the
 * pre-existing behaviour (guarded) EXCEPT two throwaway areas:
 * - a Claude Code session scratchpad;
 * - a temp area (`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, macOS
 *   `/var/folders/*\/T`) — unless the project root itself lives there (a project
 *   under /tmp keeps its guards).
 * Membership is judged on the LEXICAL normalised path (`path.resolve`, no realpath),
 * so a symlink inside the project that points out (`proj/vendor -> /tmp/ext`) is
 * still project code; conversely a path lexically in a temp area whose REAL path is
 * inside the root (and lexically outside it) is project code too.
 * Files outside the root, in a monorepo sibling or without git are NOT excluded: that
 * is main's behaviour, unchanged. Non-code extensions never count. Relative paths
 * resolve against `cwd`; with neither `CLAUDE_PROJECT_DIR` nor `cwd` only the
 * scratchpad rule applies.
 * @param filePath - Absolute or relative file path as recorded by the hooks.
 * @param cwd - Hook cwd (fallback project root; base for relative paths). Optional.
 * @param env - Environment to read `CLAUDE_PROJECT_DIR` / `TMPDIR` from (injectable for tests).
 * @returns Whether the guards must treat the file as real project code.
 */
export function isProjectCode(filePath: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!filePath || !isCodeFile(filePath)) return false;
  const rootRaw = env.CLAUDE_PROJECT_DIR || cwd;
  const abs = resolve(cwd ?? rootRaw ?? "/", filePath);
  if (!rootRaw) return !isClaudeScratchpad(abs);
  const root = resolve(rootRaw);
  // (a) A session-scratchpad file is throwaway — unless the root itself sits in a scratchpad (case 19). This wins even when the
  // root is a parent of the scratchpad (`CLAUDE_PROJECT_DIR=/private/tmp`, `/private`, `/`: case 27b).
  if (isClaudeScratchpad(abs)) return isClaudeScratchpad(join(root, "x")) && isInside(root, abs);
  // (b) Otherwise a file lexically inside the root is ALWAYS project code (`TMPDIR=<proj>/tmp`: case 15).
  if (isInside(root, abs)) return true;
  // (c) Outside the root: a temp-area file is throwaway (project under /tmp keeps its guards) unless a symlink makes it really live in the project.
  const rootInTemp = inTempArea(root, env) || inTempArea(canonical(root), env);
  return !(inTempArea(abs, env) && !rootInTemp) || isInside(canonical(root), canonical(abs));
}

/**
 * Keep only the project-code files of a list (see {@link isProjectCode}).
 * @param files - Candidate file paths.
 * @param cwd - Hook cwd.
 * @param env - Environment (injectable for tests).
 * @returns The subset the guards must consider, order preserved.
 */
export function projectCodeFiles(files: readonly string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return files.filter((f) => isProjectCode(f, cwd, env));
}

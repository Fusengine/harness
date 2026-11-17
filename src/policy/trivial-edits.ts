import { isAbsolute, relative } from "node:path";
import type { Prompt } from "../prompt/types";
import { isInsideRoot } from "../util/is-inside-root";
import { resolveProjectDir } from "../util/project-dir";
import { projectRootOrNull } from "../util/project-root";

/**
 * Pre-filters of the ported enforce-apex-phases.ts hook, in Python order
 * (lines 48-65): protected-path guard first, then the dependency/build-dir
 * skip, then the trivial-edit fast path. The trivial COUNTER itself lives in
 * the SessionTrack (`trivialEdits`, see recordTrivialEdit/trivialCount) — no
 * separate state file.
 */

/** Hook-managed state paths — Write/Edit always denied (parity enforce-apex-phases.ts PROTECTED_PATHS). */
export const PROTECTED_PATHS: RegExp = /\.claude\/(plugins\/(marketplaces|cache)|logs\/00-apex|fusengine-cache\/skill-tracking)/;

/** Dependency/build dirs the APEX gates skip entirely (parity enforce-apex-phases.ts SKIP_DIRS). */
export const SKIP_DIRS: RegExp = /(node_modules|vendor|dist|build|\.next|DerivedData)/;

/** Same names as {@link SKIP_DIRS}, but each must be a WHOLE path segment (in-project matching). */
const SKIP_SEGMENT: RegExp = /(?:^|[\\/])(?:node_modules|vendor|dist|build|\.next|DerivedData)(?:[\\/]|$)/;

/**
 * True when `filePath` lies in a dependency/build dir. Inside the project root
 * a path is skipped only when one of its root-relative segments EQUALS a skip
 * dir name, so a parent folder outside the project (`/srv/rebuild/app/src/a.ts`)
 * or a lookalike (`src/rebuilder/a.ts`, `distribution/a.ts`) never disables the
 * gates. No resolvable root, a relative path, or a path outside the root keeps
 * the legacy whole-path {@link SKIP_DIRS} match.
 * @param filePath - Target path of the edit (or undefined).
 * @param cwd - Hook cwd, used (with CLAUDE_PROJECT_DIR) to resolve the project root.
 * @returns Whether the APEX gates must skip this path.
 */
export function isSkippedPath(filePath: string | undefined, cwd?: string): boolean {
  const p = filePath ?? "";
  if (!isAbsolute(p) || !cwd) return SKIP_DIRS.test(p);
  const root = projectRootOrNull(resolveProjectDir(cwd));
  if (!root || !isInsideRoot(root, p)) return SKIP_DIRS.test(p);
  return SKIP_SEGMENT.test(relative(root, p));
}

/**
 * Absolute deny on Write/Edit of hook-managed state paths, with the Python
 * wording byte-for-byte. Runs BEFORE the code-ext/skip-dirs filters (parity
 * enforce-apex-phases.ts:48-54), so non-code files under the protected roots
 * are covered too.
 * @param tool - The harness tool name (only Write/Edit are policed).
 * @param filePath - Target path of the edit (or undefined).
 * @returns A blocking prompt, or null to fall through.
 */
export function protectedPathGate(tool: string, filePath: string | undefined): Prompt | null {
  if ((tool !== "Write" && tool !== "Edit") || !filePath || !PROTECTED_PATHS.test(filePath)) return null;
  return {
    kind: "block",
    title: "APEX Hook Guard: protected path",
    reason:
      "[APEX Hook Guard] Write blocked — this path is managed automatically by APEX hooks. Manual edits are forbidden and would corrupt tracked state.",
  };
}

/** An Edit whose new_string spans fewer lines than this is "trivial" (parity: < 5). */
export const TRIVIAL_MAX_LINES = 5;

/**
 * True when this tool-use qualifies for the trivial fast path (parity
 * enforce-apex-phases.ts:58-65): only an Edit (a Write always creates or
 * replaces a file wholesale), NEVER `replace_all`, and a new_string under
 * {@link TRIVIAL_MAX_LINES} lines. Absent content is NOT trivial (fail closed
 * — the full gates run).
 * @param tool - The harness tool name.
 * @param content - The Edit's new_string (adapter-normalized).
 * @param isReplaceAll - The Edit's replace_all flag.
 */
export function isTrivialEdit(tool: string, content: string | undefined, isReplaceAll?: boolean): boolean {
  if (tool !== "Edit" || isReplaceAll === true || content === undefined) return false;
  return content.split("\n").length < TRIVIAL_MAX_LINES;
}

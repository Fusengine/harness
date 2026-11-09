import { resolveProjectDir } from "../util/project-dir";
import { defaultStateDir } from "./paths";

/**
 * Per-project harness state dir for a hook's `cwd`, keyed on the SAME project
 * root everywhere (`CLAUDE_PROJECT_DIR` wins over `cwd`). Use this instead of a
 * raw `defaultStateDir(cwd)`: a sub-directory `cwd` would otherwise hash to a
 * different dir and split the session track, evidence, receipts and dedup
 * sidecars across two places.
 * @param cwd - Hook payload cwd (fallback when `CLAUDE_PROJECT_DIR` is unset).
 * @returns Absolute state directory (not yet created on disk).
 */
export function projectStateDir(cwd: string): string {
  return defaultStateDir(resolveProjectDir(cwd));
}

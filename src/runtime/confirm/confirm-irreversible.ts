import { GIT_BLOCKED, matchGitPatterns } from "../../policy/patterns";
import { expand } from "../../policy/effective-segments";
import { isConfirmableRm } from "./confirm-rm";

/**
 * A single flag token carrying BOTH `r` and `f` in either order (`-rf`,
 * `-fr`, `-rfv`, …) — same lookahead technique as patterns.ts's
 * `CLEAN_FD_FLAG`, reused here rather than re-derived (DRY).
 */
const RM_COMBINED_FLAG = /\s-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+(?:\s|=|$)/;
/** Split flags `-r ... -f` (either order) within the SAME command segment (no `;&|` between). */
const RM_SPLIT_FLAG = /\brm\b[^;&|\n]*\s-r\b[^;&|\n]*\s-f\b|\brm\b[^;&|\n]*\s-f\b[^;&|\n]*\s-r\b/;

/**
 * Generic `rm -rf`/`-fr` (ANY target, not just `/`/`~`) — deliberately
 * broader than `src/codex-rules/rules/rm-variants.ts`'s root/system-path-only
 * forbidden list: G4 must treat every recursive force-delete as
 * never-confirmable, not only the ones aimed at a system path.
 */
function isRmRf(cmd: string): boolean {
  return /\brm\b/.test(cmd) && (RM_COMBINED_FLAG.test(cmd) || RM_SPLIT_FLAG.test(cmd));
}

/**
 * G4: commands NEVER unlockable by a CONFIRM token, regardless of a valid,
 * fresh, correctly-scoped one. Reuses {@link GIT_BLOCKED} (push --force,
 * reset --hard, clean -fd, branch -D, rebase --force — DRY, same list the
 * rest of the policy already enforces) plus a generic `rm -rf` check. The ONE
 * exception is a single plain `rm` of literal, non-root targets
 * ({@link isConfirmableRm}): it gets a code and a trash suggestion instead.
 * @param cmd - The command a prompt is about (empty/undefined = not irreversible).
 */
export function isIrreversible(cmd: string | undefined): boolean {
  if (!cmd || isConfirmableRm(cmd)) return false;
  return matchGitPatterns(cmd, GIT_BLOCKED) || isRmRf(cmd) || expand(cmd).items.some((item) => item.verb === "rm" && isRmRf(item.text));
}

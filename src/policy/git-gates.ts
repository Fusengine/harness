import { matchGitPatterns, GIT_BLOCKED, GIT_ASK } from "./patterns";
import type { PolicyResult } from "./interfaces/types";

/**
 * Evaluate the two git confirmation gates — destructive block ({@link
 * GIT_BLOCKED}) and confirmation ask ({@link GIT_ASK}) — against `command`.
 * Skipped entirely when `ralphSafe` is true: Ralph mode already silent-
 * allowed the command upstream (parity with evaluate.ts's pre-existing
 * `!ralphSafe &&` guards). Returns the matching gate's {@link PolicyResult},
 * or `null` when neither gate matches.
 */
export function evaluateGitGates(command: string | undefined, ralphSafe: boolean): PolicyResult | null {
  if (ralphSafe || !command) return null;
  if (matchGitPatterns(command, GIT_BLOCKED)) {
    const reason = `Destructive git command: ${command}`;
    return {
      decision: "deny",
      message: reason,
      prompt: {
        kind: "block",
        title: "Destructive git command",
        reason,
        actions: ["Use a non-destructive alternative (e.g. --force-with-lease; avoid --hard / -D)"],
      },
    };
  }
  if (matchGitPatterns(command, GIT_ASK)) {
    return {
      decision: "deny",
      message: `Git operation requires confirmation: ${command}`,
      prompt: {
        kind: "ask",
        title: "Confirm git operation",
        reason: `Authorize: ${command.trim()}`,
        actions: ["Approve if this git operation is intended"],
      },
    };
  }
  return null;
}

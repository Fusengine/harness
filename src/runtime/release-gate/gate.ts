import type { Prompt } from "../../prompt/types";
import { releaseAction } from "../../policy/release-command";
import { readReviewReports } from "./store";

/** Inputs of the release gate (all injected: pure and testable). */
export interface ReleaseGateContext {
  projectDir: string;
  /** Epoch ms of the last CODE edit of the session (0 = none). */
  lastEdit: number;
  now: number;
  home?: string;
}

/**
 * Deterministic release gate: `gh pr merge` and tag-creating `git tag` need a
 * sniper AND a challenger report (stamped at SubagentStop) newer than the last
 * CODE edit. Returns an `ask` prompt (native confirm on Claude Code, CONFIRM
 * code on Codex/Kimi/Cursor) or `null` when allowed / not a release step.
 * `git commit` is never matched.
 * @param command - Raw Bash command.
 * @param ctx - Gate context.
 */
export function releaseGatePrompt(command: string, ctx: ReleaseGateContext): Prompt | null {
  const action = releaseAction(command);
  if (!action) return null;
  // No code edit in this session (docs-only / version-bump-only release): nothing to re-verify.
  if (ctx.lastEdit <= 0) return null;
  const { sniper, challenger } = readReviewReports(ctx.projectDir, ctx.home);
  const missing = [sniper > ctx.lastEdit ? "" : "sniper", challenger > ctx.lastEdit ? "" : "challenger"].filter(Boolean);
  if (missing.length === 0) return null;
  const what = action === "merge" ? "gh pr merge" : "git tag";
  return {
    kind: "ask",
    ruleId: "release-gate",
    title: "Release gate",
    reason: `${what} needs a fresh ${missing.join(" + ")} report (newer than the last code edit).`,
    actions: ["Run fuse-ai-pilot:sniper then fuse-ai-pilot:challenger, then retry", "Or approve explicitly if this release is intended"],
  };
}

import type { Prompt } from "../../prompt/types";
import { releaseAction } from "../../policy/release-command";
import { hostAgentRef } from "../../policy/apex-target";
import { readReviewReports } from "./store";

/**
 * The "run the review agents, then retry" action line, naming the agents the way
 * the running host does (Claude Code: `fuse-ai-pilot:sniper`; others: `sniper`).
 * @param id - Harness id (default Claude Code: text unchanged).
 */
export function reviewActionLine(id: string = "claude-code"): string {
  return `Run ${hostAgentRef(id, "sniper")} then ${hostAgentRef(id, "challenger")}, then retry`;
}

/** Inputs of the release gate (all injected: pure and testable). */
export interface ReleaseGateContext {
  projectDir: string;
  /** Epoch ms of the last CODE edit of the session (0 = none). */
  lastEdit: number;
  now: number;
  home?: string;
  /** Running host id (names the review agents in the action line); default Claude Code. */
  id?: string;
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
    actions: [reviewActionLine(ctx.id), "Or approve explicitly if this release is intended"],
  };
}

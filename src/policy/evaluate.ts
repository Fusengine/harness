import { isFileSizeScoped, resolveSolidRefFramework } from "./file-size-scope";
import { countLines, evaluateFileSize } from "./file-size";
import { computeEditResultLines, computePatchResultLines } from "./edit-outcome";
import { resolveMaxLines } from "../config/limits";
import { matchGitPatterns, GIT_BLOCKED, RALPH_SAFE, isRalphMode } from "./patterns";
import { runGuards } from "./guards";
import { isSingleCommand, buildNeverApprovalPrompt, NEVER_SAFE, isSafePushForm } from "./never-approval";
import { evaluateGitGates } from "./git-gates";
import type { PolicyContext, PolicyResult } from "./interfaces/types";

export type { PolicyContext, PolicyResult } from "./interfaces/types";

/**
 * Evaluate a single tool-use against the bundled policies, returning a pure
 * decision plus a portable {@link Prompt}. Adapters translate the prompt into
 * their harness's native response (Claude `permissionDecision`, etc.).
 */
export function evaluate(ctx: PolicyContext): PolicyResult {
  const guard = runGuards(ctx);
  // A guard's ask (e.g. `eval`) must not hide a destructive-git block further down the chain.
  const destructive = guard?.kind === "ask" ? evaluateGitGates(ctx.command, false) : null;
  if (destructive?.prompt?.kind === "block") return destructive;
  if (guard) return { decision: "deny", message: guard.reason, prompt: guard };
  // Ralph mode (opt-in via RALPH_MODE) exempts the SAFE git commands from the git
  // block/ask gates for autonomous runs — parity git-guard.py:48-51. Destructive
  // commands are NOT in RALPH_SAFE, so force-push / reset --hard stay blocked.
  const cmd = ctx.command;
  const ralphSafe = !!cmd && isRalphMode() && RALPH_SAFE.some((s) => cmd.startsWith(s));
  // Codex `approval_policy=never` has no ask channel: for the NEVER_SAFE subset
  // (RALPH_SAFE + "git push"), never destructive (GIT_BLOCKED) and never chained
  // (isSingleCommand — `git commit -m x && git push --force` must NOT slip
  // through), auto-approve with a visible `warn` instead of falling through to
  // GIT_ASK's normal `ask`. isSafePushForm additionally narrows the "git push"
  // entry: it excludes --delete/--mirror/--prune and a `:refspec` remote-delete,
  // none of which GIT_BLOCKED catches (that gate only covers --force). RALPH_MODE
  // takes priority (ralphSafe already silent-allows above this) — its own path
  // stays on RALPH_SAFE, unaffected by this push exemption.
  const neverExempt = !ralphSafe && !!ctx.neverApproval && !!cmd && !matchGitPatterns(cmd, GIT_BLOCKED) && isSingleCommand(cmd) && NEVER_SAFE.some((s) => cmd.startsWith(s)) && isSafePushForm(cmd);
  if (neverExempt && cmd) {
    const prompt = buildNeverApprovalPrompt(cmd);
    return { decision: "warn", message: prompt.reason, prompt };
  }
  const gitGate = evaluateGitGates(ctx.command, ralphSafe);
  if (gitGate) return gitGate;
  if (ctx.filePath && isFileSizeScoped(ctx.filePath) && ctx.agentType !== "Explore" && ctx.agentType !== "Plan") {
    const incoming = ctx.content !== undefined ? countLines(ctx.content) : 0;
    const existing = ctx.existingLines ?? 0;
    const max = ctx.maxLines ?? resolveMaxLines();
    // A computable Edit outcome bypasses the on-disk-only ceiling below: either
    // the result itself is compliant, or the file was already oversized and
    // this Edit strictly shrinks it (see policy/edit-outcome.ts). Fails closed
    // to the ceiling whenever the outcome isn't computable. `ctx.hunks` (Codex
    // apply_patch's pre-sized `@@` chunks) takes priority over the single
    // oldString/content pair — every other caller (Claude Edit, Cursor) leaves
    // it undefined, so their single-pair path below is untouched.
    const editResult = ctx.tool === "Edit" && ctx.existingContent !== undefined
      ? ctx.hunks !== undefined
        ? computePatchResultLines(ctx.existingContent, ctx.hunks)
        : ctx.content !== undefined
          ? computeEditResultLines(ctx.existingContent, ctx.oldString, ctx.content, ctx.isReplaceAll === true)
          : null
      : null;
    if (editResult !== null && (editResult <= max || editResult < existing)) {
      return { decision: "allow", message: null };
    }
    // Write provides the full new content → judge it. Edit judges the computed
    // outcome when known (closes the old grow-via-Edit hole), else the on-disk file.
    const lines = ctx.tool === "Edit" ? (editResult ?? Math.max(incoming, existing)) : incoming || existing;
    const framework = resolveSolidRefFramework(ctx.filePath);
    // Python parity (enforce-file-size.py:44-57): the block message always
    // reports the pre-existing on-disk count, even for a Write whose new
    // content is itself over the limit — the incoming count only ever gates
    // an early "shrunk to compliant" allow, it's never what gets displayed.
    const displayLines = ctx.tool === "Write" ? ctx.existingLines ?? lines : lines;
    const verdict = evaluateFileSize(lines, max, ctx.filePath, framework, displayLines, ctx.target, ctx.patchPath);
    if (lines > 0 && !verdict.ok) {
      return {
        decision: "deny",
        message: verdict.message,
        prompt: {
          kind: "block",
          title: "SOLID file-size limit",
          reason: verdict.message ?? "",
          actions: [`Split into modules under ${verdict.max} lines (Single Responsibility)`, "Then re-run the write"],
        },
        meta: { framework, lines: verdict.lines, max: verdict.max },
      };
    }
  }
  return { decision: "allow", message: null };
}

import type { RefsThunk } from "../refs/lazy";
import type { RefMeta } from "../refs/types";

/** A tool-use to gate, plus the session pointers needed for the stateful gates. */
export interface GateInput {
  sessionId: string;
  framework: string;
  tool: string;
  filePath?: string;
  content?: string;
  command?: string;
  cwd?: string;
  /** Claude Code `scratchpad_dir` (runtime/normalize.ts) — threaded to evaluate() for the Bash redirect window only. */
  scratchpadDir?: string;
  refs?: RefMeta[];
  /** Lazy refs source (handle-pre.ts): consulted by the APEX-scoped gate only when `refs` is absent, so Bash/Read/trivial edits never pay the refs scan. */
  loadRefs?: RefsThunk;
  now: number;
  trackFile: string;
  windowMs?: number;
  isReplaceAll?: boolean;
  /** Edit only: the tool_input.old_string being replaced (runtime/normalize.ts) — threaded to evaluate()'s file-size gate so it can compute the post-edit outcome (policy/edit-outcome.ts) instead of judging the stale on-disk count alone. */
  oldString?: string;
  agentType?: string;
  /** Claude `agent_id` when the tool-use comes from a subagent (parity require-apex-agents.py:41 — subagents inherit the lead's brainstorm decision). */
  agentId?: string;
  /** Absolute path to the session transcript (Claude `transcript_path`) for evidence-based freshness. */
  transcriptPath?: string;
  /** See PolicyContext.neverApproval — populated only by handle-pre.ts for id==="codex" (approval_policy=never has no interactive ask channel). */
  neverApproval?: boolean;
  /**
   * Codex `apply_patch` only (runtime/apply-patch-apex.ts): `<tool_use_id>:<entry index>:<file>`.
   * Codex runs every sibling plugin hook of one tool call concurrently with the
   * same `tool_use_id`, so the trivial-edit budget is charged once per key
   * instead of once per sibling. Absent everywhere else (unchanged behavior).
   */
  trivialClaimKey?: string;
  /** Codex `apply_patch` only (set with or without a `tool_use_id`): the entry's index in the patch, the sub-millisecond slot of its trivial charge (see gate-apex.ts `trivialStamp`). */
  trivialSlot?: number;
}

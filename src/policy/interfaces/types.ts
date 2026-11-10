import type { Prompt } from "../../prompt/types";
import type { PatchHunkDelta } from "../edit-outcome";

/** Harness-agnostic input to {@link evaluate}. */
export interface PolicyContext {
  /** Tool name (e.g. "Write", "Edit", "Bash"). */
  tool: string;
  filePath?: string;
  content?: string;
  command?: string;
  /** Claude Code `scratchpad_dir` (see GuardContext.scratchpadDir); undefined on every other host. */
  scratchpadDir?: string;
  /** Optional override for the SOLID max-lines limit. */
  maxLines?: number;
  /** Subagent type — `Explore`/`Plan` are exempt from the file-size gate. */
  agentType?: string;
  /** Line count of the existing on-disk file (so an Edit on an oversized file blocks). */
  existingLines?: number;
  /** Edit only: full on-disk content, read once by the runtime (runtime/gate-helpers.ts::existingLineCounts) — lets evaluate() compute the exact post-edit line count instead of judging the stale pre-edit count alone. Undefined when unreadable/missing (fail-closed to the existingLines-only behavior). */
  existingContent?: string;
  /** Edit only: the tool_input.old_string being replaced (runtime/normalize.ts). Undefined for Write (no such field) — fail-closed. */
  oldString?: string;
  /** Edit only: the tool_input.replace_all flag — every occurrence of old_string is replaced, not just the first. */
  isReplaceAll?: boolean;

  /**
   * Codex `apply_patch` Update File only, populated by runtime/apply-patch-gate.ts:
   * one pre-sized `@@` chunk per entry. When set, evaluate() computes the
   * post-patch line count via edit-outcome.ts's `computePatchResultLines`
   * instead of the single `oldString`/`content` pair above — undefined for
   * every other caller (Claude Edit, Cursor), whose single-pair path is unchanged.
   */
  hunks?: readonly PatchHunkDelta[];

  /**
   * Codex-only: the project-relative path to name in the `apply_patch`
   * remediation line of the SOLID file-size deny (`*** Update File: <path>`),
   * so a Codex agent can recopy it verbatim. Undefined for every other caller.
   */
  patchPath?: string;

  /** Codex-only, populated by handle-pre.ts from the resolved `permission_mode` of an `approval_policy=never` session (adapters/codex/permission-mode.ts) — auto-approve gate, wired through evaluate.ts's anti-chaining check. */
  neverApproval?: boolean;

  /**
   * Message-rendering target for the SOLID file-size deny (file-size.ts::evaluateFileSize).
   * Populated ONLY by runtime/apply-patch-gate.ts as `"codex"` (apply_patch has
   * no `Write` tool and no `~/.claude` plugin tree). Undefined for every other
   * caller — the Claude/Cursor deny message stays byte-for-byte unchanged.
   */
  target?: string;
}

/** Harness-agnostic policy decision (+ a portable prompt for adapters to render). */
export interface PolicyResult {
  decision: "allow" | "deny" | "warn";
  message: string | null;
  prompt?: Prompt;
  meta?: Record<string, unknown>;
}

/** Phrasing for the "view pending / mark in-progress / mark done" step trio (APEX task-context injection, steps 3/4/7). See `apex-target-steps.ts`. */
export interface ApexTaskSteps {
  step3: string;
  step4: string;
  step7: string;
}

/** Phrasing for the "before starting / when done" pair (APEX sub-agent injection, SubagentStart). See `apex-target-steps.ts`. */
export interface ApexAgentSteps {
  beforeStart: string;
  whenDone: string;
}

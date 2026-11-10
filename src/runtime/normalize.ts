import { parseApplyPatch, type PatchHunk } from "../adapters/codex/apply-patch";
import { extractCursorEvent } from "../adapters/cursor/normalize";
import { commandToString } from "./command-string";
import { canonicalizeCodexShellTool } from "./codex-shell-tool";
import { canonicalizeMcpToolName } from "./mcp-tool-name";

/** One file/edit fanned out from Codex `apply_patch` or Cursor `afterFileEdit`. */
export interface NormalizedFile {
  filePath: string;
  content: string;
  oldString?: string;
  op: "add" | "update" | "delete";
  /** Codex `apply_patch` Update File only: the pre-sized `@@` chunks (adapters/codex/apply-patch.ts) the SOLID file-size gate uses to judge the file AFTER the patch. Absent for add/delete and for Cursor. */
  hunks?: PatchHunk[];
}

/** A hook event normalized across harnesses. */
export interface NormalizedEvent {
  /** Native event name when the adapter exposes one explicitly (Cursor). */
  eventName?: string;
  phase: "pre" | "post";
  tool: string;
  input: Record<string, unknown>;
  sessionId: string;
  filePath?: string;
  content?: string;
  /** Edit only: the tool_input.old_string being replaced — lets the file-size gate (policy/evaluate.ts + policy/edit-outcome.ts) compute the post-edit outcome instead of judging the stale on-disk count alone. Undefined for Write (no such field) and for cline/apply_patch (parsed separately, no equivalent field). */
  oldString?: string;
  command?: string;
  /** Cursor-only independent command candidates from beforeMCPExecution. */
  commandCandidates?: string[];
  /** Subagent type, if the tool-use came from one (Explore/Plan are file-size-exempt). */
  agentType?: string;
  /** Harness-resolved permission mode (Claude emits it natively; Codex maps `AskForApproval::Never` to the same "bypassPermissions" string — see adapters/codex/permission-mode.ts). Generic field, Codex-only consumer today. */
  permissionMode?: string;
  /** Codex logical tool-use identity, shared by sibling hook callbacks. */
  toolUseId?: string;
  /** Sub-agent identifier, if the tool-use came from one (Claude/Codex only — Cursor/Kimi never send this field, confirmed live). */
  agentId?: string;
  /** Harness-reported working directory used to scope Codex authorization. */
  cwd?: string;
  /** Claude Code only: the exact session scratchpad dir (`scratchpad_dir`); no other host sends an equivalent field, so it stays undefined elsewhere. */
  scratchpadDir?: string;
  /** Validated Cursor multi-root workspace paths in wire order. */
  workspaceRoots?: string[];
  /**
   * Per-file changes for Codex `apply_patch` and per-edit changes for Cursor
   * `afterFileEdit`; undefined for single-file events.
   */
  files?: NormalizedFile[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Normalize a hook payload, including Cline nesting and native Cursor events.
 */
export function normalizeEvent(id: string, payload: Record<string, unknown>): NormalizedEvent {
  if (id === "cline") {
    const post = payload.postToolUse as Record<string, unknown> | undefined;
    const node = (post ?? (payload.preToolUse as Record<string, unknown> | undefined)) ?? {};
    const params = (node.parameters as Record<string, unknown> | undefined) ?? {};
    return {
      phase: post ? "post" : "pre",
      tool: str(node.toolName) ?? "",
      input: params,
      sessionId: str(payload.taskId) ?? "",
      filePath: str(params.path),
      content: str(params.content),
      command: str(params.command),
    };
  }
  if (id === "cursor") {
    return {
      ...extractCursorEvent(payload),
      sessionId: str(payload.session_id) ?? str(payload.conversation_id) ?? "",
      agentType: str(payload.agent_type),
      agentId: str(payload.agent_id),
      permissionMode: str(payload.permission_mode),
    };
  }
  const event = str(payload.hook_event_name) ?? "";
  const input = (payload.tool_input as Record<string, unknown> | undefined) ?? payload;
  const tool = canonicalizeCodexShellTool(id, canonicalizeMcpToolName(id, str(payload.tool_name) ?? ""));
  const base = {
    phase: (/post|after/i.test(event) ? "post" : "pre") as "pre" | "post",
    tool,
    input,
    sessionId: str(payload.session_id) ?? str(payload.conversation_id) ?? "",
    agentType: str(payload.agent_type) ?? str(input.subagent_type),
    agentId: str(payload.agent_id),
    permissionMode: str(payload.permission_mode),
    toolUseId: str(payload.tool_use_id),
    cwd: str(payload.cwd),
    scratchpadDir: id === "claude-code" ? str(payload.scratchpad_dir) : undefined,
  };
  // Codex's `apply_patch` (its PRIMARY edit primitive) carries the whole change
  // set as a freeform patch in `command` — no `file_path`/`content`, so the
  // file-size/DRY/protected-path gates saw nothing (enforcement 0%). Fan it out
  // into `files` and DROP the patch text from `command` so it can't false-match
  // the git guards. Every other tool is untouched below.
  if (tool === "apply_patch") {
    const patch = str(input.command) ?? str(payload.command) ?? "";
    const files = parseApplyPatch(patch).map((f) => (f.hunks ? { filePath: f.path, content: f.content, op: f.op, hunks: f.hunks } : { filePath: f.path, content: f.content, op: f.op }));
    return { ...base, phase: base.phase, files: files.length > 0 ? files : undefined };
  }
  return {
    ...base,
    filePath: str(input.file_path) ?? str(input.path) ?? str(payload.file_path),
    content: str(input.content) ?? str(input.new_string),
    oldString: str(input.old_string),
    command: commandToString(input.command) ?? commandToString(payload.command),
  };
}

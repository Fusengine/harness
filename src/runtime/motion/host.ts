import { parseApplyPatch } from "../../adapters/codex/apply-patch";
import type { MotionCall, MotionKind } from "../../policy/interfaces/motion";
import { promptText } from "../prompt-text";
import type { NormalizedEvent } from "../normalize";
import { createHash } from "node:crypto";
import { recordObject as rec } from "../../util/record-object";

const CLAUDE_EVENTS: Readonly<Record<string, MotionKind>> = { SubagentStart: "subagentStart", SubagentStop: "subagentStop", UserPromptSubmit: "prompt", PreToolUse: "pre", PostToolUse: "post", PostToolUseFailure: "failure", Stop: "stop" };
const GEMINI_EVENTS: Readonly<Record<string, MotionKind>> = { BeforeTool: "pre", AfterTool: "post", BeforeAgent: "prompt", AfterAgent: "stop" };
const HERMES_EVENTS: Readonly<Record<string, MotionKind>> = { pre_tool_call: "pre", post_tool_call: "post", pre_llm_call: "prompt" };
const CURSOR_EVENTS: Readonly<Record<string, MotionKind>> = {
  beforeShellExecution: "pre", preToolUse: "pre", beforeReadFile: "pre", postToolUse: "post", afterShellExecution: "post", beforeSubmitPrompt: "prompt", postToolUseFailure: "failure", stop: "stop", subagentStop: "subagentStop",
};
const CLINE_EVENTS: Readonly<Record<string, MotionKind>> = { PreToolUse: "pre", PostToolUse: "post", UserPromptSubmit: "prompt", TaskComplete: "stop" };
/** Non-Claude native tool names -> the canonical name the gates key on (gemini-cli, cline, hermes only). */
const TOOLS: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  run_shell_command: "Bash", execute_command: "Bash", terminal: "Bash",
  write_file: "Write", write_to_file: "Write", replace: "Edit", replace_in_file: "Edit", patch: "Edit", read_file: "Read",
});
const CANON_HOSTS = new Set(["gemini-cli", "cline", "hermes"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Native event name of the call (Cline carries it as `hookName`, everyone else as `hook_event_name`). */
function nativeName(id: string, payload: Record<string, unknown>): string {
  return id === "cline" ? str(payload.hookName) : str(payload.hook_event_name);
}

/**
 * True only on claude-code. There — and only there — a SubagentStop with a
 * non-empty `agent_id` releases that sub-agent's FRESH render reservations
 * (only entries written with the exact same `agent_id` can match, so this is
 * safe on every host version). Codex gets NO release: an `exec_command`
 * returns control to the model while the process keeps running (no
 * PostToolUse until it finishes, and the process can outlive the turn), so
 * a sub-agent can emit SubagentStop while its render is still active —
 * releasing there would admit a concurrent render and lose the late
 * completion. The main turn's Stop releases NOTHING on any host: a
 * sub-agent's PreToolUse may carry no `agent_id`, so its reservations are
 * indistinguishable from the main turn's — a main-turn leak falls by the
 * TTL alone. Every other host (kimi, codex, cursor, gemini-cli, cline,
 * hermes) gets NO release on Stop/SubagentStop at all: a sub-agent's end
 * cannot be told apart from the main turn's there (kimi fires a
 * marker-free Stop with the shared session_id); the TTL and the 24 h
 * horizon are the only backstop.
 * @param id - Harness id.
 */
export function stopReleasesRenders(id: string): boolean {
  return id === "claude-code";
}

/** Host -> native event table. */
function table(id: string): Readonly<Record<string, MotionKind>> {
  if (id === "cursor") return CURSOR_EVENTS;
  if (id === "gemini-cli") return GEMINI_EVENTS;
  if (id === "hermes") return HERMES_EVENTS;
  return id === "cline" ? CLINE_EVENTS : CLAUDE_EVENTS;
}

/** Prompt text from the host-specific field (Cline nests it, Hermes carries it as `extra.user_message`). */
function hostPrompt(id: string, payload: Record<string, unknown>): string {
  if (id === "cline") return promptText(rec(payload.userPromptSubmit).prompt);
  if (id === "hermes") return promptText(payload.prompt ?? payload.user_message ?? rec(payload.extra).user_message);
  return promptText(payload.prompt);
}

/** Hermes `patch` carries a V4A patch string: fan it out into `files` like Codex `apply_patch`. */
function withFiles(id: string, event: NormalizedEvent): NormalizedEvent {
  const patch = str(event.input.patch);
  if (id !== "hermes" || patch === "") return event;
  const files = parseApplyPatch(patch).map((f) => ({ filePath: f.path, content: f.content, op: f.op }));
  return files.length > 0 ? { ...event, files } : event;
}

/** Same event with its tool name made canonical (identity for claude-code, codex, kimi, cursor). */
function canonical(id: string, event: NormalizedEvent): NormalizedEvent {
  if (!CANON_HOSTS.has(id)) return event;
  const tool = TOOLS[event.tool];
  return withFiles(id, tool ? { ...event, tool } : event);
}

/**
 * Reduce a host-native hook call to the Claude-shaped view the motion gates read.
 * claude-code, codex and kimi pass through untouched (same event names and tool names).
 * @param id - Harness id.
 * @param payload - Raw hook payload.
 * @param event - Event normalized by `normalizeEvent`.
 * @param projectRoot - Canonical motion root resolved for this command, shared by pre and post.
 */
export function motionCall(id: string, payload: Record<string, unknown>, event: NormalizedEvent, projectRoot?: string): MotionCall {
  const name = nativeName(id, payload);
  let kind = table(id)[name] ?? "none";
  const result = rec(payload.tool_response ?? payload.tool_result ?? payload.postToolUse);
  if (kind === "post" && (result.success === false || result.is_error === true || result.error !== undefined || payload.error !== undefined || payload.interrupted === true)) kind = "failure";
  // Cursor: a sub-agent's own conversation (`parent_tool_call_id`) can never approve.
  const human = !(id === "cursor" && payload.parent_tool_call_id !== undefined);
  const respondAs = id === "cursor" ? name : kind === "post" ? "PostToolUse" : kind === "failure" ? "PostToolUseFailure" : kind === "stop" || kind === "subagentStop" ? "Stop" : kind === "prompt" ? "UserPromptSubmit" : "PreToolUse";
  const normalized = canonical(id, event);
  const native = event.toolUseId || (id === "kimi" ? str(payload.tool_call_id) : "") || (id === "cursor" ? str(payload.tool_use_id) : "");
  // Hosts without a native id get a single-flight command identity; never use time-based expiry.
  const fallback = CANON_HOSTS.has(id) || id === "cursor" ? normalized.command ? `noid:${id}:${event.sessionId}:${createHash("sha256").update(projectRoot === undefined ? normalized.command : JSON.stringify([projectRoot, normalized.command])).digest("hex")}` : undefined : undefined;
  // JSON-encode (session, call) so ids containing ':' can never alias another pair.
  const scoped = native ? `${id}:${JSON.stringify([event.sessionId, native])}` : fallback;
  return { kind, respondAs, event: { ...normalized, toolUseId: scoped }, text: kind === "prompt" ? hostPrompt(id, payload) : "", human };
}

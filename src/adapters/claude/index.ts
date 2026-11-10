/** Claude Code adapter — the thin Claude-only shim over the portable policy core; reads the hook stdin payload and emits hookSpecificOutput responses. */
import { evaluate } from "../../policy/evaluate";
import { formatPrompt, type Prompt } from "../../prompt/types";
import { readStdin } from "../../util/runtime-io";
import { commandToString } from "../../runtime/command-string";

/** Subset of the Claude Code hook stdin payload we consume. */
export interface ClaudeHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; content?: string; new_string?: string; command?: string | string[] };
  cwd?: string;
  /** Exact session scratchpad dir sent by Claude Code on every hook event. */
  scratchpad_dir?: string;
  /** Shared Claude/Codex hook field — Codex maps approval_policy=never to "bypassPermissions" (adapters/codex/permission-mode.ts). */ permission_mode?: string;
}

/** Read & parse the Claude hook payload from stdin (empty object on bad input). */
export async function readClaudeInput(): Promise<ClaudeHookInput> {
  const text = await readStdin();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeHookInput) : {};
  } catch {
    return {};
  }
}

/** A `deny` hook response for a given event. PreToolUse-only field. */
export function denyResponse(event: string, reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

/**
 * A PostToolUse (and Stop/UserPromptSubmit) `block` response: those events
 * ignore `permissionDecision` (PreToolUse-only) and only honor the top-level
 * `decision`/`reason` keys, which feed `reason` back to Claude.
 */
export function blockResponse(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

/** An `additionalContext` injection response. */
export function contextResponse(event: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** A raw `systemMessage` notice — shown to the user without blocking the tool. Mirrors the shared Python `hook_output.allow_pass`/`post_pass` convention. */
export function systemMessage(text: string): string {
  return JSON.stringify({ systemMessage: text });
}

/** An `inform` response with a user-visible notice (Python `allow_pass`/`post_pass` parity): a pure pass reuses {@link systemMessage} alone; with agent-facing `context` both channels merge in one JSON. */
export function informResponse(event: string, notice: string, context: string): string {
  if (!context) return systemMessage(notice);
  return JSON.stringify({ systemMessage: notice, hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

/** Attach a `systemMessage`, MERGING it with any already present (`\n`-joined) instead of overwriting — several producers may each call this on the same stdout in one hook invocation. */
export function attachSystemMessage(stdout: string, notice: string): string {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>, prev = typeof parsed.systemMessage === "string" ? parsed.systemMessage : "";
    return JSON.stringify({ ...parsed, systemMessage: prev ? `${prev}\n${notice}` : notice });
  } catch { return systemMessage(notice); }
}

/** Render a portable {@link Prompt} as a Claude Code hook response: `block` → deny, `ask` → interactive `permissionDecision`, `inform` → `additionalContext` (+ `systemMessage` when `userMessage` is set). */
export function toClaudeResponse(event: string, prompt: Prompt): string {
  const reason = formatPrompt(prompt);
  if (prompt.kind === "block") return denyResponse(event, reason);
  if (prompt.kind === "ask") {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "ask", permissionDecisionReason: reason } });
  }
  if (prompt.userMessage) return informResponse(event, prompt.userMessage, prompt.reason ? reason : "");
  return contextResponse(event, reason);
}

/** Run the bundled policy over a Claude payload and return the native response string (deny/ask/additionalContext), or null to allow. */
export function guard(input: ClaudeHookInput): string | null {
  const result = evaluate({
    tool: input.tool_name ?? "Write",
    filePath: input.tool_input?.file_path,
    content: input.tool_input?.content ?? input.tool_input?.new_string,
    command: commandToString(input.tool_input?.command),
    scratchpadDir: typeof input.scratchpad_dir === "string" ? input.scratchpad_dir : undefined,
  });
  if (result.decision === "allow" || !result.prompt) return null;
  return toClaudeResponse(input.hook_event_name ?? "PreToolUse", result.prompt);
}

/** @deprecated use {@link guard}. Kept for back-compat. */
export const fileSizeGuard: typeof guard = guard;

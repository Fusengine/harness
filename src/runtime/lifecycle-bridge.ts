import { dispatchLifecycle, postEditTypescript, trackSessionChanges, type PluginScope } from "./lifecycle";
import { autoDocumentRead } from "./lifecycle/auto-document-reads";
import { contextResponse } from "../adapters/claude";
import { cursorEventContract } from "../adapters/cursor/events";
import { toCursorLifecycleResponse } from "../adapters/cursor/respond";
import type { NormalizedEvent } from "./normalize";

/** Raw event name from a payload (Cline lacks one; lifecycle is Claude-only). */
function rawEvent(payload: Record<string, unknown>): string {
  return typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
}

/** Extract the `additionalContext` body from a `contextResponse(...)` stdout string ("" when empty/unparseable). */
function additionalContextOf(stdout: string): string {
  if (!stdout) return "";
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

/**
 * Run the ported lifecycle/session/context hooks (SessionStart, SubagentStart/
 * Stop, TeammateIdle, PostToolUseFailure, PreCompact, SessionEnd,
 * InstructionsLoaded, rules-scope UserPromptSubmit). Returns the native stdout
 * when handled, or `null` to fall through to the tool-use pipeline.
 * @param payload - The raw hook payload.
 * @param cwd - Project root.
 * @param scope - The invoking plugin scope (defaults to `core`).
 * @param now - Clock.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The native stdout, or `null` when unhandled.
 */
export function lifecycleStdout(payload: Record<string, unknown>, cwd: string, scope: PluginScope, now: number, id: string = "claude-code"): string | null {
  const wireEvent = rawEvent(payload);
  if (id !== "cursor") return dispatchLifecycle({ event: wireEvent, payload, cwd, scope, now, id });
  const lifecycleEvent = cursorEventContract(wireEvent).lifecycle;
  if (lifecycleEvent === null) return null;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : payload.conversation_id;
  const stdout = dispatchLifecycle({
    event: lifecycleEvent,
    payload: { ...payload, session_id: sessionId },
    cwd,
    scope,
    now,
    id,
  });
  return stdout === null ? null : toCursorLifecycleResponse(stdout, wireEvent);
}

/**
 * Post-edit additions for core-scope PostToolUse: auto-document a Read of a
 * SKILL.md/README/docs file; else (Write/Edit) track cumulative session
 * changes (sniper reminder) AND report eslint/prettier issues — parity
 * core-guards hooks.json, which runs both as independent PostToolUse commands
 * rather than short-circuiting one on the other. Returns the combined extra
 * stdout, or "" when nothing to emit.
 * @param scope - The invoking plugin scope.
 * @param event - The normalized event.
 * @param now - Clock.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @param cwd - Hook cwd (project-root fallback for the edit stamp; the event's own `cwd` wins).
 * @returns The extra stdout (possibly empty).
 */
export async function postEditContext(scope: PluginScope, event: NormalizedEvent, now: number, id: string = "claude-code", cwd?: string): Promise<string> {
  if (scope !== "core" || !event.filePath) return "";
  if (event.tool === "Read") return autoDocumentRead(event.filePath, now, id);
  if (event.tool !== "Write" && event.tool !== "Edit") return "";
  const sniper = trackSessionChanges(event.sessionId, event.filePath, undefined, now, { agentId: event.agentId, cwd: event.cwd ?? cwd });
  const lint = postEditTypescript(event.filePath);
  if (!sniper || !lint) return sniper || lint;
  return contextResponse("PostToolUse", `${additionalContextOf(sniper)}\n\n${additionalContextOf(lint)}`);
}

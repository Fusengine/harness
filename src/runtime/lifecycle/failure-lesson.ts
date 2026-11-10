/**
 * @module failure-lesson
 * PostToolUseFailure handler: keep the failure log, record the failure in the
 * one-shot metric, and inject the ONE most-specific lesson whose `error:` trigger
 * matches the failure message — reusing the PreToolUse {@link lessonFor} index and
 * its cooldown (idempotent under the ~11-process fan-out). Fail-open throughout.
 *
 * Claude-Code-only in the sense that no equivalent `PostToolUseFailure` hook
 * exists on Codex or Hermes — but Cursor's own `postToolUseFailure` DOES
 * arrive here too, via `lifecycle-bridge.ts`'s `lifecycleStdout` translating
 * the wire event name and forwarding to `dispatchLifecycle`'s
 * `"PostToolUseFailure"` case (see `handle.ts`'s `cursorRawPayloadProjection`
 * for how `data.tool_name` below arrives already canonicalized on Cursor).
 * @packageDocumentation
 */
import { homedir } from "node:os";
import { contextResponse } from "../../adapters/claude";
import { lessonFor } from "../../policy/lessons/lesson-gate";
import { lessonsFileFor } from "./lessons/state";
import { projectRoot } from "../../util/project-root";
import { oncePerWindow } from "../inject-dedup";
import { projectStateDir } from "../project-state-dir";
import { recordFailure } from "../../tracking/one-shot-failure";
import { logToolFailure } from "./tool-failure";
import type { OncePerWindow } from "../../policy/lessons/types";

/** The failure message across the documented `error` field and defensive fallbacks; "" when none. */
function failureError(data: Record<string, unknown>): string {
  const raw = data.error ?? data.tool_error ?? data.tool_output;
  if (typeof raw === "string") return raw;
  return raw != null ? JSON.stringify(raw) : "";
}

/**
 * Handle PostToolUseFailure: log the failure, tally it per tool, and inject the
 * matching `error:`-triggered lesson as `additionalContext` ("" when none).
 * @param data - The raw PostToolUseFailure payload (`tool_name`, `error`, `session_id`).
 * @param cwd - Project root.
 * @param home - Home dir (defaults to `~`).
 * @param now - Clock (defaults to `Date.now()`).
 * @param once - Cooldown gate (injected for tests; defaults to {@link oncePerWindow}).
 * @returns The native hook stdout, or "" when nothing to inject.
 */
export function failureLessonContext(data: Record<string, unknown>, cwd: string, home: string = homedir(), now: number = Date.now(), once: OncePerWindow = oncePerWindow): string {
  logToolFailure(data, home, now);
  const tool = typeof data.tool_name === "string" ? data.tool_name : "unknown";
  const sessionId = typeof data.session_id === "string" ? data.session_id : undefined;
  try { recordFailure(tool, { now, dir: projectStateDir(cwd), sessionId }); } catch { /* metric never breaks the hook */ }
  const errorMsg = failureError(data);
  if (!errorMsg) return "";
  // tool="" + empty input isolates matching to the `error:` regex (rank 1),
  // reusing the PreToolUse gate's index + cooldown — no second lesson engine.
  const lesson = lessonFor("", {}, { file: lessonsFileFor(projectRoot(cwd)), once, prevError: errorMsg });
  return lesson?.reason ? contextResponse("PostToolUseFailure", lesson.reason) : "";
}

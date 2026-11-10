/**
 * Bash verification-receipt extraction for PostToolUse: a static-check/test
 * run (see `receipt-runners`) is parsed (exit code + output) into a signed
 * receipt the TaskCompleted gate later demands. Structured responses ONLY: Kimi Code CLI sends
 * `tool_output` as a truncated STRING (no exit_code, no stdout/stderr
 * channels) — parsing it would forge a success receipt (`exit 0`, empty
 * output) for possibly-failed runs, so a non-object source is skipped.
 */
import { captureReceipt } from "../tracking/receipts";
import { isDirectRunnerCommand, isSingleSimpleCommand } from "../tracking/receipt-command";

/**
 * Record a verification receipt for a Bash run when the response is structured.
 * @param file - Session track file.
 * @param tool - The tool name (only "Bash" receipts exist).
 * @param command - The executed command.
 * @param toolResult - `payload.tool_result` (preferred), when present.
 * @param response - `payload.tool_response ?? payload.tool_output` fallback.
 * @param now - Clock.
 * @param durationMs - `payload.duration_ms` (tool run time, optional in Claude Code): lets the receipt record when the run STARTED.
 * @param claudePost - Set ONLY for host `claude-code` on a `PostToolUse` event (never `PostToolUseFailure`); carries that payload's `tool_input`. Enables the narrow implied-exit-0 rule below; absent = every other host/event.
 */
export async function captureBashReceipt(
  file: string,
  tool: string,
  command: string | undefined,
  toolResult: unknown,
  response: unknown,
  now: number,
  durationMs?: unknown,
  claudePost?: { toolInput: Record<string, unknown> },
): Promise<void> {
  if (tool !== "Bash" || !command) return;
  const r = (toolResult ?? response) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown; interrupted?: unknown; backgroundTaskId?: unknown } | undefined;
  if (!r || typeof r !== "object") return;
  // Claude Code's real PostToolUse Bash `tool_response` carries NO `exit_code`
  // (verified live). A foreground non-zero exit is delivered as
  // PostToolUseFailure (never reaches here), BUT PostToolUse also fires with
  // exit 0 for runs whose real exit it does not know: background tasks
  // (`run_in_background` / `backgroundTaskId`, empty output) and pipelines (the
  // exit code is the last stage's, and a filter can hide the failure lines). So
  // the implied exit 0 is granted ONLY to a foreground (run_in_background
  // absent/false), uninterrupted (`interrupted === false`), single simple
  // command whose runner is a DIRECT checker/test binary (never an npm/yarn/
  // bun-run script launcher: its exit is the last command of an opaque
  // package.json script); anything else keeps the
  // D4 rule below (no exit_code = no receipt, as before). The parsed counts
  // still decide pass/fail. Other hosts / a present exit_code are unchanged.
  const implied =
    claudePost !== undefined &&
    r.exit_code === undefined &&
    r.interrupted === false &&
    r.backgroundTaskId === undefined &&
    (claudePost.toolInput.run_in_background === undefined || claudePost.toolInput.run_in_background === false) &&
    isSingleSimpleCommand(command) &&
    isDirectRunnerCommand(command);
  const exitCode = implied ? 0 : r.exit_code;
  // D4: a missing/non-finite exit_code is NOT the same as exit 0 — crediting
  // it would forge a passing receipt for a response shape that never
  // actually reported success. Skip capture entirely rather than guess.
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode)) return;
  const out = `${typeof r.stdout === "string" ? r.stdout : ""}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  await captureReceipt(file, command, out, exitCode, now, typeof durationMs === "number" ? durationMs : undefined);
}

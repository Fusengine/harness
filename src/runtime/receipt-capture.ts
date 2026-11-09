/**
 * Bash verification-receipt extraction for PostToolUse: a static-check/test
 * run (see `receipt-runners`) is parsed (exit code + output) into a signed
 * receipt the TaskCompleted gate later demands. Structured responses ONLY: Kimi Code CLI sends
 * `tool_output` as a truncated STRING (no exit_code, no stdout/stderr
 * channels) — parsing it would forge a success receipt (`exit 0`, empty
 * output) for possibly-failed runs, so a non-object source is skipped.
 */
import { captureReceipt } from "../tracking/receipts";

/**
 * Record a verification receipt for a Bash run when the response is structured.
 * @param file - Session track file.
 * @param tool - The tool name (only "Bash" receipts exist).
 * @param command - The executed command.
 * @param toolResult - `payload.tool_result` (preferred), when present.
 * @param response - `payload.tool_response ?? payload.tool_output` fallback.
 * @param now - Clock.
 * @param durationMs - `payload.duration_ms` (tool run time, optional in Claude Code): lets the receipt record when the run STARTED.
 */
export async function captureBashReceipt(
  file: string,
  tool: string,
  command: string | undefined,
  toolResult: unknown,
  response: unknown,
  now: number,
  durationMs?: unknown,
): Promise<void> {
  if (tool !== "Bash" || !command) return;
  const r = (toolResult ?? response) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
  if (!r || typeof r !== "object") return;
  // D4: a missing/non-finite exit_code is NOT the same as exit 0 — crediting
  // it would forge a passing receipt for a response shape that never
  // actually reported success. Skip capture entirely rather than guess.
  if (typeof r.exit_code !== "number" || !Number.isFinite(r.exit_code)) return;
  const out = `${typeof r.stdout === "string" ? r.stdout : ""}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  await captureReceipt(file, command, out, r.exit_code, now, typeof durationMs === "number" ? durationMs : undefined);
}

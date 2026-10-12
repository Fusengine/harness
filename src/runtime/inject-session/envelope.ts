/**
 * @module inject-session/envelope
 * Read/rewrite helpers for Claude hook stdout (`hookSpecificOutput.additionalContext`),
 * used by {@link module:inject-session/filter}. Everything but `additionalContext`
 * (systemMessage, decisions, other fields) passes through untouched.
 */

/** Parse hook stdout into an object; `{}` for empty, null when it is not a JSON object. */
export function parseEnvelope(stdout: string): Record<string, unknown> | null {
  if (!stdout.trim()) return {};
  try {
    const v: unknown = JSON.parse(stdout);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Does this output carry a decision (deny/ask/block/stop) that must stay untouched? */
export function isDecision(obj: Record<string, unknown>): boolean {
  const hso = obj.hookSpecificOutput as Record<string, unknown> | undefined;
  return obj.decision !== undefined || obj.continue === false || hso?.permissionDecision !== undefined;
}

/** The `additionalContext` string of an envelope ("" when absent). */
export function contextOf(obj: Record<string, unknown>): string {
  const v = (obj.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext;
  return typeof v === "string" ? v : "";
}

/**
 * Re-serialize `obj` with `ctx` as its additionalContext. An empty `ctx`
 * removes the field and prunes the envelope down to nothing when no other
 * field remains (so a fully-deduplicated hook prints no output at all).
 * @param obj - Parsed envelope.
 * @param event - Hook event name for `hookEventName`.
 * @param ctx - New additionalContext ("" to remove).
 * @returns The stdout string.
 */
export function withContext(obj: Record<string, unknown>, event: string, ctx: string): string {
  const { hookSpecificOutput, ...rest } = obj;
  const hso: Record<string, unknown> = { ...(hookSpecificOutput as Record<string, unknown> | undefined), hookEventName: event };
  if (ctx) return JSON.stringify({ ...rest, hookSpecificOutput: { ...hso, additionalContext: ctx } });
  delete hso.additionalContext;
  const out = Object.keys(hso).some((k) => k !== "hookEventName") ? { ...rest, hookSpecificOutput: hso } : rest;
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

/**
 * @module post-compact
 * PostCompact handler (core scope): re-inject the reconciliation snapshot plus a
 * one-line reminder that read-state may have been reset by compaction, so the
 * agent re-reads files before editing. Deduped per session/window (compaction can
 * fan out too). Fully fail-open — any error yields "".
 * @packageDocumentation
 */
import { contextResponse, systemMessage } from "../../adapters/claude";
import { oncePerWindow } from "../inject-dedup";
import { projectStateDir } from "../project-state-dir";
import { renderSnapshot } from "./snapshot";

/** Re-inject at most once per 30s per session (compaction fan-out + retries). */
const COMPACT_DEDUP_MS = 30_000;

/** One-line reminder prepended to the re-injected snapshot. */
const REMINDER = "Context was compacted — reread files before editing (read-state may be reset).";

/**
 * Handle PostCompact: emit the reminder + reconciliation snapshot as
 * `additionalContext`, deduped per session. "" on dedup-suppress or any error.
 * @param data - The raw PostCompact payload (`session_id`, `trigger`).
 * @param cwd - Project root.
 * @param moduleUrl - `import.meta.url` of the caller (locates the running package for the version line).
 * @param now - Clock (defaults to `Date.now()`).
 * @param id - Harness adapter id (defaults to "claude-code": unchanged output). Codex's
 *   PostCompact output schema (codex-rs/hooks schema.rs, `deny_unknown_fields`) accepts only
 *   continue/stopReason/suppressOutput/systemMessage, so Codex gets the text as `systemMessage`.
 * @returns The native hook stdout, or "".
 */
export function postCompactContext(data: Record<string, unknown>, cwd: string, moduleUrl: string, now: number = Date.now(), id: string = "claude-code"): string {
  try {
    const sessionId = typeof data.session_id === "string" ? data.session_id : "unknown";
    if (!oncePerWindow(`postcompact:${sessionId}`, COMPACT_DEDUP_MS, { now, dir: projectStateDir(cwd) })) return "";
    const snapshot = renderSnapshot(cwd, moduleUrl);
    const text = snapshot ? `${REMINDER}\n\n${snapshot}` : REMINDER;
    return id === "codex" ? systemMessage(text) : contextResponse("PostCompact", text);
  } catch {
    return "";
  }
}

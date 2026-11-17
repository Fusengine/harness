/**
 * PreToolUse file-size deny for the solid scope — the same SOLID ceiling the
 * core gate chain enforces (`policy/evaluate.ts`), extracted so
 * `harness hook <id> solid` blocks oversized Write/Edit WITHOUT the core-only
 * APEX freshness gates (they require explore/research agents that not every
 * harness runs). Pure and read-only (on-disk read via {@link existingLineCounts},
 * no session state), so the sibling-plugin fan-out stays idempotent.
 */
import { countLines, evaluateFileSize } from "../policy/file-size";
import { isFileSizeScoped, resolveSolidRefFramework } from "../policy/file-size-scope";
import { computeEditResultLines } from "../policy/edit-outcome";
import { resolveMaxLines } from "../config/limits";
import { existingLineCounts } from "./gate-helpers";
import type { Prompt } from "../prompt/types";

/**
 * Deny a Write/Edit whose resulting file would exceed the SOLID line ceiling.
 * Mirrors `policy/evaluate.ts` exactly: a computable Edit outcome passes when
 * the result is compliant OR strictly shrinks an already-oversized file; the
 * block message reports the pre-existing on-disk count for a Write.
 * @param tool - The tool name (only "Write"/"Edit" are checked).
 * @param filePath - The written file's absolute path.
 * @param content - Write: the full new content; Edit: the `new_string` snippet.
 * @param oldString - Edit only: the `old_string` being replaced.
 * @param isReplaceAll - Edit only: whether every occurrence is replaced.
 * @param agentType - Subagent type, when known (Explore/Plan are exempt).
 * @param hostId - Running host id: a non-Claude host never gets the phantom `~/.claude` skill path in the deny (absent = Claude Code, message unchanged).
 * @returns The blocking prompt, or null when compliant or out of scope.
 */
export function solidFileSizeGate(
  tool: string,
  filePath: string | undefined,
  content: string | undefined,
  oldString?: string,
  isReplaceAll: boolean = false,
  agentType?: string,
  hostId?: string,
): Prompt | null {
  if (tool !== "Write" && tool !== "Edit") return null;
  if (!filePath || !isFileSizeScoped(filePath)) return null;
  if (agentType === "Explore" || agentType === "Plan") return null;
  const { raw: existingLines, content: existingContent } = existingLineCounts(filePath);
  const incoming = content !== undefined ? countLines(content) : 0;
  const existing = existingLines ?? 0;
  const max = resolveMaxLines();
  const editResult = tool === "Edit" && existingContent !== undefined && content !== undefined
    ? computeEditResultLines(existingContent, oldString, content, isReplaceAll)
    : null;
  if (editResult !== null && (editResult <= max || editResult < existing)) return null;
  const lines = tool === "Edit" ? (editResult ?? Math.max(incoming, existing)) : incoming || existing;
  const displayLines = tool === "Write" ? (existingLines ?? lines) : lines;
  const verdict = evaluateFileSize(lines, max, filePath, resolveSolidRefFramework(filePath), displayLines, "", "", hostId);
  if (lines === 0 || verdict.ok) return null;
  return {
    kind: "block",
    title: "SOLID file-size limit",
    reason: verdict.message ?? "",
    actions: [`Split into modules under ${verdict.max} lines (Single Responsibility)`, "Then re-run the write"],
  };
}

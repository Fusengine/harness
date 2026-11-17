import { frameworkSolidGate } from "../policy/framework-solid";
import { skillTriggerGate } from "../policy/skill-triggers";
import { requiredArchSkill } from "../policy/detect-project";
import { countFrameworkCodeLines } from "../policy/file-size";
import { isExcludedJsPath, isExcludedSwiftPath } from "../policy/framework-solid-exclude";
import type { GateInput } from "./gate-input";
import type { Prompt } from "../prompt/types";

/** PHP paths the Laravel skill check skips — broader than the SOLID vendor-only exclude (parity check-laravel-skill.py `/(vendor|storage|bootstrap/cache)/`). */
const PHP_SKILL_EXCLUDE_RE: RegExp = /\/(vendor|storage|bootstrap\/cache)\//;

/**
 * Whether the sub-skill gate should skip this path — parity with the early return
 * in check-*-skill.py (build/vendor artifacts never require a sub-skill).
 * @param framework - the detected framework ("laravel" | "swift" | JS otherwise).
 * @param filePath - the file being written.
 */
function skillGateExcluded(framework: string, filePath: string): boolean {
  if (framework === "laravel") return PHP_SKILL_EXCLUDE_RE.test(filePath);
  if (framework === "swift") return isExcludedSwiftPath(filePath);
  return isExcludedJsPath(filePath);
}

/**
 * Effective line count for the SOLID size check. On an Edit, `content` is only
 * the `new_string` snippet, so for Next.js — mirroring the base file-size guard
 * and the Python `get_full_file_content` — judge the larger of the snippet and
 * the full on-disk file (`existingCodeLines`). Other frameworks (react/laravel/
 * swift) judge the edited snippet alone, never the on-disk full-file max — their
 * Python source never imports `get_full_file_content`, only nextjs does. On
 * Write, `content` IS the full file, so the snippet count stands regardless of
 * framework (undefined → the gate falls back to `countFrameworkCodeLines`).
 * @param tool - the tool name ("Edit" | "Write" | ...).
 * @param framework - the detected framework; only "nextjs" applies the full-file max.
 * @param content - the written content (snippet on Edit, full file on Write).
 * @param existingCodeLines - full on-disk code-only line count, when known.
 */
function effectiveLines(
  tool: string,
  framework: string,
  content: string,
  existingCodeLines?: number,
): number | undefined {
  if (tool !== "Edit" || existingCodeLines === undefined) return undefined;
  if (framework !== "nextjs") return countFrameworkCodeLines(content);
  return Math.max(countFrameworkCodeLines(content), existingCodeLines);
}

/**
 * Framework-aware SOLID + sub-skill gate, run on the Write/Edit path once a
 * `filePath` is present. Combines:
 *  - {@link frameworkSolidGate}: framework-specific SOLID rules (line limits,
 *    interface/protocol separation, `'use client'`, @MainActor...).
 *  - {@link skillTriggerGate}: blocks when written APIs need a sub-skill that
 *    was not read this session, also forcing the modular-architecture skill
 *    resolved from disk via {@link requiredArchSkill}.
 *
 * @param input - the gated tool-use (filePath + content + framework + cwd).
 * @param refsRead - in-session read reference paths (from the loaded track).
 * @param existingCodeLines - full on-disk code-only line count (so an Edit on
 *   an oversized file still fires the framework SOLID size rule). Omit on Write.
 * @returns the first blocking {@link Prompt}, or `null` to allow.
 */
export function frameworkSkillGate(
  input: GateInput,
  refsRead: string[],
  existingCodeLines?: number,
): Prompt | null {
  if (!input.filePath) return null;
  const content = input.content ?? "";
  const solid = frameworkSolidGate(input.filePath, content, effectiveLines(input.tool, input.framework, content, existingCodeLines));
  if (solid) return solid;
  // Skill-gate path exclusions (parity check-*-skill.py early return): a build/
  // vendor artifact never triggers the sub-skill requirement. Applied only to the
  // skill check, not frameworkSolidGate (whose PHP exclude is vendor-only).
  if (skillGateExcluded(input.framework, input.filePath)) return null;
  const forced = input.cwd ? requiredArchSkill(input.cwd) : null;
  return skillTriggerGate(input.framework, content, refsRead, forced, input.cwd, input.filePath, input.hostId);
}

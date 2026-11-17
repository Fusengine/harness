import { basename } from "node:path";
import { resolveMaxLines, splitTarget } from "../config/limits";
import { isNonClaudeHost, solidSkillDir } from "./host-skill-paths";

/**
 * Fixed marketplace plugins root — parity with Python `enforce-file-size.py`'s
 * literal, unexpanded `~/...` string. Exported: reused by
 * `policy/apex.ts::solidReadGate` for its "no reference matched" deny message.
 */
export const PLUGINS_DIR = "~/.claude/plugins/marketplaces/fusengine-plugins/plugins";

/**
 * Skill-dir fragment per framework — parity with Python
 * `enforce-file-size.py::get_solid_ref()` (falls back to `generic/`). Exported:
 * reused by `policy/apex.ts::solidReadGate` (see {@link PLUGINS_DIR}).
 */
export const SOLID_REF: Record<string, string> = {
  react: "react-expert/skills/solid-react/",
  nextjs: "nextjs-expert/skills/solid-nextjs/",
  "tanstack-start": "tanstack-start-expert/skills/solid-tanstack-start/",
  laravel: "laravel-expert/skills/solid-php/",
  swift: "swift-apple-expert/skills/solid-swift/",
  go: "solid/skills/solid-go/",
  rust: "solid/skills/solid-rust/",
};

/** Verdict from {@link evaluateFileSize}. */
export interface FileSizeVerdict {
  ok: boolean;
  lines: number;
  max: number;
  message: string | null;
}

/**
 * Count physical lines — parity with the Python `enforce-file-size.py`
 * (`sum(1 for _ in f)`): every line counts (blanks and comments included), and a
 * single trailing newline does not add a phantom line. The SOLID ceiling is
 * measured on raw file length, not substantive code, to match the upstream plugin.
 */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * Count non-empty, non-comment lines — parity with the Python `count_code_lines`
 * shared by the framework-specific SOLID validators: `_shared/scripts/validate_solid_common.py`
 * (imported by `nextjs-expert/scripts/validate-nextjs-solid.py` and
 * `swift-apple-expert/scripts/validate-swift-solid.py`), duplicated verbatim in
 * `react-expert/scripts/validate-react-solid.py` / `laravel-expert/scripts/validate-laravel-solid.py`.
 * Strips blank lines and lines starting with `//` or `*` — a SINGLE fixed rule
 * for all 4 callers (the Python `comment` param defaults to, and every real
 * call site leaves it at, `"//"` — never per-language despite covering
 * ts/tsx/js/jsx, php and swift).
 *
 * Deliberately distinct from two other "code-only" counters already in this
 * repo, neither of which is a faithful substitute here:
 *  - `countLoc` (`runtime/lifecycle/check-file-size.ts`): a genuinely
 *    per-language table (PHP additionally strips `#`, Python strips
 *    `#`/`"""`/`'''`) — ported from the unrelated `solid/scripts/check-file-size.py`.
 *  - `countCodeLines` (`runtime/lifecycle/aipilot/solid-compliance.ts`): also
 *    strips `#` — ported from `ai-pilot/scripts/check-solid-compliance.py`.
 * Reusing either would silently strip PHP `#`/Python-style comments that the
 * real react/nextjs/laravel/swift validators do NOT strip.
 * @param content - The file content to measure.
 */
export function countFrameworkCodeLines(content: string): number {
  let count = 0;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    count++;
  }
  return count;
}

/**
 * Evaluate a file's line count against the SOLID limit.
 * @param lines - the file's line count
 * @param max - the limit (defaults to `resolveMaxLines()`)
 * @param target - Message-rendering target (policy/interfaces/types.ts::PolicyContext.target).
 *   `"codex"` swaps the Claude-specific remediation (`~/.claude` plugin path,
 *   `Write` tool) for an `apply_patch`-compatible one; every other value (incl.
 *   the default `""`) renders the ORIGINAL Claude message, byte-for-byte.
 * @param hostId - Running host id: a non-Claude host never gets the phantom `~/.claude` path (its own skill dir if it exists, else a real discovered one, else neutral wording). Claude / empty: unchanged.
 * @param patchPath - Codex only: project-relative path recopied verbatim into
 *   the `*** Update File:` remediation (a bare basename would name a file that
 *   does not exist at the project root). Falls back to the basename.
 */
export function evaluateFileSize(
  lines: number,
  max: number = resolveMaxLines(),
  filePath = "",
  framework = "generic",
  displayLines: number = lines,
  target = "",
  patchPath = "",
  hostId = "",
): FileSizeVerdict {
  if (lines <= max) return { ok: true, lines, max, message: null };
  const split = splitTarget(max);
  const fname = filePath ? basename(filePath) : "file";
  const ref = SOLID_REF[framework] ?? "generic/";
  // A non-Claude host is pointed at a SOLID skill dir that exists (its own, else the real discovered one); none → neutral wording. Claude: the historical string.
  const solidDir = isNonClaudeHost(hostId) ? solidSkillDir(ref, hostId) ?? "the SOLID skill in your own skills directory" : `${PLUGINS_DIR}/${ref}`;
  const message = target === "codex"
    ? `BLOCKED: '${fname}' has ${displayLines} lines (max: ${max}). TO SPLIT: 1) Create new module files (<${split} lines each) 2) Use apply_patch (*** Update File: ${patchPath || fname}) to shrink it to <${max} lines.`
    : `BLOCKED: '${fname}' has ${displayLines} lines (max: ${max}). TO SPLIT: 1) Read SOLID rules: ${solidDir} 2) Create new module files (<${split} lines each) 3) Use Write to replace '${fname}' with <${max} lines version.`;
  return { ok: false, lines, max, message };
}

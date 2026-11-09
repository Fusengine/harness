import { projectRootOrNull } from "../../../util/project-root";
import { oneShotSummary } from "../../../tracking/one-shot";
import { collectGit } from "./git";
import { collectVersion } from "./version";
import { collectBoard } from "./board";
import { renderSections, attachSnapshot, type Section } from "./format";

/** Run `fn`, swallowing any throw into `""` so no single collector can break the hook. */
function safe(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "";
  }
}

/**
 * Build the reconciliation snapshot markdown for `cwd`: git state, running
 * harness version + drift, the persistent board, and one-shot gate status. Each
 * collector is isolated by {@link safe}; an all-empty result yields `""`.
 * @param cwd - The session working directory.
 * @param moduleUrl - `import.meta.url` of the caller (locates the running package).
 * @returns The snapshot markdown, or `""` when nothing to report.
 */
export function renderSnapshot(cwd: string, moduleUrl: string): string {
  const root = projectRootOrNull(cwd) ?? cwd;
  const sections: Section[] = [
    { title: "Git", body: safe(() => collectGit(root)) },
    { title: "Version", body: safe(() => collectVersion(root, moduleUrl)) },
    { title: "Board", body: safe(() => collectBoard(root)) },
    // raw `cwd` (not `root`): oneShotSummary derives the state dir via projectStateDir(cwd),
    // the same resolution (CLAUDE_PROJECT_DIR wins over cwd) the runtime writes gate counters under (handle.ts).
    { title: "One-shot gates", body: safe(() => oneShotSummary(cwd)) },
  ];
  return renderSections(sections);
}

/**
 * Concatenate the reconciliation snapshot onto a core SessionStart stdout. Fully
 * fail-safe: any error returns `stdout` unchanged so the hook never breaks.
 * @param stdout - The core SessionStart JSON stdout (may be `""`).
 * @param cwd - The session working directory.
 * @param moduleUrl - `import.meta.url` of the caller.
 * @returns The merged hook stdout.
 */
export function withSnapshot(stdout: string, cwd: string, moduleUrl: string): string {
  try {
    return attachSnapshot(stdout, renderSnapshot(cwd, moduleUrl));
  } catch {
    return stdout;
  }
}

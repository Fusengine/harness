/**
 * Claude Code's real session scratchpad: `<tmp>/claude-<numeric uid>/<project-slug>/<session-uuid>/scratchpad/`.
 * The uuid segment is mandatory so a user project dir that merely contains `claude-3/…/scratchpad/` is NOT matched.
 */
const CLAUDE_SCRATCHPAD = /(?:^|\/)claude-\d+\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad\//i;

/**
 * True for a path inside a Claude Code session scratchpad (throwaway probes, never project code).
 * Deliberately NOT "any tmpdir": a project living under /tmp keeps its receipt gate.
 * @param filePath - Absolute or relative file path.
 * @returns Whether the path sits in a real session scratchpad.
 */
export function isClaudeScratchpad(filePath: string): boolean {
  return CLAUDE_SCRATCHPAD.test(filePath);
}

/**
 * Resolve the project root the way Claude Code defines it: the exported
 * `CLAUDE_PROJECT_DIR` (stable for the whole session, even when a tool call
 * runs from a sub-directory) wins over the hook payload `cwd`.
 *
 * Every per-project state path (`defaultStateDir`, track file, evidence harvest)
 * must be keyed on THIS value, or one session splits its state across hashes.
 * @param cwd - Fallback project root when `CLAUDE_PROJECT_DIR` is unset or empty.
 * @param env - Environment to read (defaults to `process.env`; injectable for tests).
 * @returns The project directory to hash/key state on.
 */
export function resolveProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : cwd;
}

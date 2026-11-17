/**
 * @module paths
 * Runtime path helpers — per-project, out-of-tree harness state.
 *
 * Default base: ~/.fuse-harness/state/<projectHash>/
 * where projectHash = 8-char MD5 of CLAUDE_PROJECT_DIR (or cwd).
 * Persistent and not world-writable (unlike /tmp), and OUTSIDE the repo so the
 * agent has no "legitimate" reason to write it: the protected-path guard denies
 * agent Write/Edit/Bash writes to `~/.fuse-harness/state/` and `~/.fuse-harness/.key`
 * (the harness's own writes run inside the hook process, never through a tool call).
 * Reads stay allowed. The gate verifies freshness from the transcript, not this file.
 *
 * @packageDocumentation
 */

import { join } from "node:path";
import { hashText } from "../util/json-io";
import { fuseHarnessHome } from "./home-state";

/** Resolve the project root from the environment or fall back to cwd. */
function resolveProjectDir(): string {
  return process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
}

/**
 * Compute a stable 8-char hex hash for a project directory path.
 * Delegates to `hashText` (MD5, non-cryptographic — used as a stable dir key only).
 *
 * @param projectDir - Absolute path to the project root; defaults to CLAUDE_PROJECT_DIR/cwd.
 * @returns 8-char lowercase hex string.
 */
export function projectHash(projectDir?: string): string {
  return hashText(projectDir ?? resolveProjectDir());
}

/**
 * Canonical base directory for per-project harness state.
 * Resolves to: ~/.fuse-harness/state/<projectHash>/
 *
 * @param projectDir - Optional override for hashing; defaults to CLAUDE_PROJECT_DIR/cwd.
 * @returns Absolute directory path (not yet created on disk).
 */
export function defaultStateDir(projectDir?: string): string {
  return join(fuseHarnessHome(), "state", projectHash(projectDir));
}

/**
 * Absolute path to a session's track JSON file.
 *
 * The session identifier is sanitised to `[A-Za-z0-9_-]` before use in the filename.
 *
 * @param sessionId - Claude session identifier (raw value accepted; sanitised internally).
 * @param baseDir   - Override the base directory. Omit in production; pass an explicit
 *                    temp path in unit tests to avoid touching $HOME.
 * @returns Absolute path, e.g. ~/.fuse-harness/state/a1b2c3d4/track-abc123.json
 */
export function trackFile(sessionId: string, baseDir?: string): string {
  const dir = baseDir ?? defaultStateDir();
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
  return join(dir, `track-${safe}.json`);
}

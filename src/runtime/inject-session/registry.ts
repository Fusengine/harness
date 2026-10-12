/**
 * @module inject-session/registry
 * Scopes and epochs of the per-session (and per-sub-agent) registry of
 * delivered context units, on the filesystem so the many short-lived hook
 * processes of one Claude Code session share it. Layout under
 * `<stateDir>/inject-session/<scope>/` (unit files: see {@link module:inject-session/units}):
 *   - `E<n>`           epoch marker (content = SessionStart source); current epoch = max n
 *   - `<n>.s.<scope>`  this hook scope already handled a SessionStart in epoch n (a 2nd one = a new SessionStart)
 *   - `<n>.*`          unit files of epoch n
 * A new epoch (SessionStart: startup/clear/compact/fork) drops every older
 * file, so everything is delivered again — the model context was rebuilt.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fuseHarnessHome } from "../home-state";
import { projectHash } from "../paths";

/** Epoch marker file name (`E<n>`). */
const EPOCH_RE = /^E\d+$/;

/**
 * Per-project harness state dir the registry lives in (same layout as `defaultStateDir`, with the test-only `home` override).
 * @param cwd - Project root (`CLAUDE_PROJECT_DIR` wins, like the rest of the runtime).
 * @param home - Test-only home override.
 * @returns `<home>/.fuse-harness/state/<projectHash>`.
 */
export function injectStateDir(cwd: string, home?: string): string {
  return join(fuseHarnessHome(home ?? homedir()), "state", projectHash(process.env.CLAUDE_PROJECT_DIR ?? cwd));
}

/** One open registry scope at its current epoch. */
export interface Scope {
  /** Scope directory. */
  root: string;
  /** Current epoch number (>= 1). */
  epoch: number;
}

/** Scope name: session id, plus `.a-<agent>` in a sub-agent ({@link removeSessionScopes} relies on it). */
export function scopeName(sid: string, agent: string | null): string {
  return agent ? `${sid}.a-${agent}` : sid;
}

/** Directory of the registry root (`<stateDir>/inject-session`), or of one scope inside it when `name` is given. */
export function scopeRoot(stateDir: string, name?: string): string {
  return name === undefined ? join(stateDir, "inject-session") : join(stateDir, "inject-session", name);
}

/** Stable short content hash of a unit. */
export function unitHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** Highest epoch number present in `root` (0 when none). */
export function currentEpoch(root: string): number {
  try {
    return Math.max(0, ...readdirSync(root).filter((n) => EPOCH_RE.test(n)).map((n) => Number(n.slice(1))));
  } catch {
    return 0;
  }
}

/** Create marker `E<n>` exclusively (content = SessionStart source, "~" when created lazily); true when this process won. */
function createEpoch(root: string, n: number, source: string): boolean {
  try {
    writeFileSync(join(root, `E${n}`), source, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Delete every registry file that does not belong to epoch `keep` (best effort). */
function dropOlder(root: string, keep: number): void {
  try {
    for (const n of readdirSync(root)) {
      if (n === `E${keep}` || n.startsWith(`${keep}.`)) continue;
      try { unlinkSync(join(root, n)); } catch { /* sibling already removed it */ }
    }
  } catch { /* scope vanished */ }
}

/** What a SessionStart hook process tells the registry about itself. */
export interface ResetRequest {
  /** SessionStart `source` (startup | resume | clear | compact | fork). */
  source: string;
  /** Plugin scope of the calling hook process (rules, lessons, core, ...). */
  scope: string;
}

/**
 * Read-only: the current scope without creating anything.
 * @param stateDir - Per-project harness state dir.
 * @param name - Scope name.
 * @returns The scope at its current epoch, or null when it does not exist yet.
 */
export function peekScope(stateDir: string, name: string): Scope | null {
  const root = scopeRoot(stateDir, name);
  const epoch = currentEpoch(root);
  return epoch > 0 ? { root, epoch } : null;
}

/**
 * Open (creating if needed) the registry scope. With `reset` (SessionStart) a
 * new epoch starts when the context was rebuilt, i.e. when this hook scope has
 * already handled a SessionStart in the current epoch (a repeated SessionStart)
 * or the `source` differs. Sibling hook processes of ONE SessionStart are
 * different plugin scopes, so they adopt the epoch the first one created — no
 * timing involved. `resume` keeps the registry (the resumed history still holds
 * what was injected). Throws when the state dir is unusable (callers fail open).
 * @param stateDir - Per-project harness state dir.
 * @param name - Scope name ({@link scopeName}).
 * @param reset - Present only for SessionStart events.
 * @returns The open scope.
 */
export function openScope(stateDir: string, name: string, reset?: ResetRequest): Scope {
  const root = scopeRoot(stateDir, name);
  mkdirSync(root, { recursive: true });
  let cur = currentEpoch(root);
  if (cur === 0) {
    createEpoch(root, 1, reset?.source ?? "~"); // "~" = created lazily by a non-SessionStart event: any real SessionStart supersedes it
    cur = Math.max(1, currentEpoch(root));
  }
  if (!reset) return { root, epoch: cur };
  let raw = "";
  try { raw = readFileSync(join(root, `E${cur}`), "utf-8"); } catch { /* sibling mid-creation: adopt */ }
  const rebuilt = reset.source !== "resume" && ((raw !== "" && raw !== reset.source) || existsSync(join(root, `${cur}.s.${reset.scope}`)));
  if (rebuilt) {
    if (createEpoch(root, cur + 1, reset.source)) dropOlder(root, cur + 1);
    cur = Math.max(cur + 1, currentEpoch(root));
  }
  try { writeFileSync(join(root, `${cur}.s.${reset.scope}`), "", { flag: "wx" }); } catch { /* already marked */ }
  return { root, epoch: cur };
}

/** Delete a whole session's scopes (main + sub-agents) — SessionEnd hygiene. */
export function removeSessionScopes(stateDir: string, sid: string): void {
  const base = scopeRoot(stateDir);
  try {
    for (const n of readdirSync(base)) if (n === sid || n.startsWith(`${sid}.a-`)) rmSync(join(base, n), { recursive: true, force: true });
  } catch { /* nothing to clean */ }
}

import { join, normalize } from "node:path";
import { homedir } from "node:os";
import { claudeHome, fusengineCache } from "../../runtime/home-state";
import { shellFileWriteRedirects } from "./bash-write-redirects";

/**
 * Writable paths the harness owns — writes here never need Write/Edit's APEX
 * gates. Parity safe_paths.py `SAFE_WRITE_PATHS`; `~/.claude/fusengine-cache`
 * is rebranded to `~/.fuse-harness/cache`, `~/.claude/logs` is unchanged.
 */
export const SAFE_WRITE_PATHS: readonly string[] = [fusengineCache(), join(claudeHome(), "logs")];

/** Raw, un-expanded forms of {@link SAFE_WRITE_PATHS} for substring matching
 * when a shell didn't expand `~` (parity safe_paths.py `_SAFE_RAW`). */
const SAFE_WRITE_RAW: readonly string[] = ["~/.fuse-harness/cache", "~/.claude/logs"];

/** Strip quotes, expand `~`/`$HOME`, normalize (parity safe_paths.resolve_path). */
function resolvePath(raw: string): string {
  const stripped = raw.trim().replace(/^['"]|['"]$/g, "");
  // POSIX tilde-prefix: only `~` alone or a `~/` prefix is `$HOME`-relative.
  // `~user`, `~2xyz`, `~+`, `~N` are login-name/dir-stack forms — leave unexpanded.
  const expanded = stripped === "~" || stripped.startsWith("~/") ? homedir() + stripped.slice(1) : stripped;
  return normalize(expanded.replace(/\$HOME/g, homedir()));
}

/** True when a `>`/`>>` redirect targets a harness-owned safe path (parity is_safe_write_path). */
export function isSafeWritePath(cmd: string): boolean {
  const targets = shellFileWriteRedirects(cmd)
    .map((redirect) => resolvePath(redirect.target))
    .filter((target) => target !== "/dev/null");
  return targets.length > 0 && targets.every((target) => SAFE_WRITE_PATHS.some((safe) => target === safe || target.startsWith(safe + "/")));
}

/** Extract the file argument of `tee`/`dd of=` (parity extract_command_target). */
function extractCommandTarget(cmd: string): string | null {
  const tee = cmd.match(/\btee\s+(?:-[a-z]\s+)*(\S+)/);
  if (tee?.[1]) return resolvePath(tee[1]);
  const dd = cmd.match(/\bdd\b[^|]*\bof=(\S+)/);
  return dd?.[1] ? resolvePath(dd[1]) : null;
}

/** True when a `tee`/`dd` target is a harness-owned safe path (parity is_safe_command_target). */
export function isSafeCommandTarget(cmd: string): boolean {
  const target = extractCommandTarget(cmd);
  return target !== null && SAFE_WRITE_PATHS.some((safe) => target === safe || target.startsWith(safe + "/"));
}

/**
 * True when the command quotes a safe path as a string literal (parity
 * has_safe_write_target, hardened: the Python original — and this function
 * before this fix — does an unanchored substring match, which fail-opens any
 * `node -e` containing the safe path text anywhere, including inside an inert
 * comment. Requiring it to appear as a quoted literal still covers the real
 * use case (`fs.appendFileSync('~/.fuse-harness/cache/x.json', ...)`).
 */
export function hasSafeWriteTarget(cmd: string): boolean {
  // Quote-anchored segment boundary: exact quoted literal OR quoted sub-path
  // (e.g. 'fusengineCache()/x.json' — a real file under the safe dir).
  const quoted = (p: string): boolean =>
    cmd.includes(`'${p}'`) || cmd.includes(`"${p}"`) || cmd.includes(`'${p}/`) || cmd.includes(`"${p}/`);
  return SAFE_WRITE_PATHS.some(quoted) || SAFE_WRITE_RAW.some(quoted);
}

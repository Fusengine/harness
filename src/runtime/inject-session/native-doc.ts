/**
 * @module inject-session/native-doc
 * Claude Code loads `<config dir>/CLAUDE.md` natively (and reloads it after a
 * compaction), so re-injecting its body through a hook is pure duplication.
 * Strips exactly that file's content (both the `# CLAUDE.md` heading form of
 * UserPromptSubmit and the bare form of SessionStart) — but ONLY when the file
 * we read provably is the one the host loads: same real path as the host's
 * config dir, a regular file (no symlink, no hardlink) and not matched by any
 * `claudeMdExcludes` pattern of any settings layer. Anything unconfirmed keeps
 * injecting, exactly like HEAD.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeHome } from "../home-state";

/** Below this size a "doc" is too small to be worth matching (avoids stripping incidental text). */
const MIN_DOC_CHARS = 40;
/** Managed-settings roots (macOS, Linux/WSL, Windows). */
const MANAGED_DIRS = ["/Library/Application Support/ClaudeCode", "/etc/claude-code", "C:\\Program Files\\ClaudeCode"];

/** Glob (`**`, `*`, `?`) to an anchored RegExp. */
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** Settings files of every layer (user, project, local, managed incl. `.d/`). Existing ones only. */
function settingsFiles(home: string): string[] {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  const files = [join(claudeHome(home), "settings.json")];
  if (process.env.CLAUDE_CONFIG_DIR) files.push(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
  if (proj) files.push(join(proj, ".claude", "settings.json"), join(proj, ".claude", "settings.local.json"));
  for (const dir of MANAGED_DIRS) {
    files.push(join(dir, "managed-settings.json"));
    try { for (const n of readdirSync(join(dir, "managed-settings.d")).sort()) if (n.endsWith(".json")) files.push(join(dir, "managed-settings.d", n)); } catch { /* none */ }
  }
  return files.filter((f) => existsSync(f));
}

/** True when `claudeMdExcludes` of some layer matches `paths`, or a layer cannot be read (unconfirmed = keep injecting). */
function excluded(home: string, paths: string[]): boolean {
  for (const f of settingsFiles(home)) {
    try {
      const patterns = (JSON.parse(readFileSync(f, "utf-8")) as { claudeMdExcludes?: unknown }).claudeMdExcludes;
      if (Array.isArray(patterns) && patterns.some((p) => typeof p === "string" && paths.some((x) => globToRe(p).test(x)))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The harness copy's path when it provably is the file the host loads natively, else null. */
function nativeDocPath(home: string): string | null {
  const ours = join(claudeHome(home), "CLAUDE.md");
  try {
    const st = lstatSync(ours);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) return null;
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (cfg && realpathSync(resolve(cfg)) !== realpathSync(claudeHome(home))) return null;
    return excluded(home, [ours, realpathSync(ours)]) ? null : ours;
  } catch {
    return null;
  }
}

/**
 * Remove the natively-loaded `CLAUDE.md` body from `text`.
 * @param text - The injected `additionalContext`.
 * @param home - Home dir holding `.claude/CLAUDE.md`.
 * @returns `text` without the native doc (unchanged when the doc is absent, tiny, not contained, or not provably the host's native file).
 */
export function stripNativeDoc(text: string, home: string): string {
  const path = nativeDocPath(home);
  if (!path) return text;
  let doc = "";
  try { doc = readFileSync(path, "utf-8"); } catch { return text; }
  if (doc.length < MIN_DOC_CHARS || !text.includes(doc)) return text;
  const withHeading = `# CLAUDE.md\n${doc}`;
  return (text.includes(withHeading) ? text.replace(withHeading, "") : text.replace(doc, "")).trim();
}

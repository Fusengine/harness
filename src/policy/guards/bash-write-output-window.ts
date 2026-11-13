import { literalWrites } from "./bash-write-literal";
import { MAX_LENGTH, OPAQUE_SYNTAX, PLAIN_TEXT, scanRedirects } from "./bash-write-scratchpad";
import { scratchpadDirOf, tempRoots } from "./bash-write-scratchpad-target";
import { PLAIN_WORD, REDIRECT, parseStatements } from "./bash-write-scratchpad-words";

/** Read-only git subcommands whose stdout is a report (never a checkout, config or ref change). */
const GIT_READ_ONLY = new Set(["diff", "log", "show", "status", "ls-files", "rev-parse", "rev-list", "blame", "shortlog", "describe"]);
/** Git arguments that make a read-only subcommand write a file itself. */
const GIT_WRITES = /^--output(?:=|$)/;

/** True for a plain `git <read-only subcommand> <plain words>` word list. */
function isGitReport(words: readonly string[]): boolean {
  const [git, sub, ...args] = words;
  return git === "git" && sub !== undefined && GIT_READ_ONLY.has(sub) && args.every((a) => PLAIN_WORD.test(a) && !GIT_WRITES.test(a));
}

/**
 * True only when `cmd` is ONE simple command — a read-only producer (an
 * existing scratchpad-window reader or runner, or a read-only `git`
 * subcommand) — whose every file redirect is a direct, fresh-or-regular child
 * of the session scratchpad or of a system temp dir (`/tmp`, `/private/tmp`,
 * macOS `$TMPDIR`). No pipe, list, `&`, substitution, heredoc, variable or
 * comment: the redirect opens before the producer runs, so nothing can plant
 * a link first. Everything else returns false and the caller keeps its verdict.
 * @param cmd - Full raw command.
 * @param scratchpadDir - `scratchpad_dir` from the host payload (may be absent).
 * @returns True when the command-output window applies.
 */
export function commandOutputOnlyInTemp(cmd: string, scratchpadDir: unknown): boolean {
  try {
    if (cmd.length > MAX_LENGTH || !PLAIN_TEXT.test(cmd) || OPAQUE_SYNTAX.test(cmd) || /[;|\n$]/.test(cmd)) return false;
    // Literal text is not command output: it goes to the Write/Edit tool (bash-write-literal.ts), even into temp.
    if (literalWrites(cmd) !== null) return false;
    const redirects = scanRedirects(cmd, scratchpadDirOf(scratchpadDir), tempRoots());
    if (redirects === null || redirects.files === 0 || redirects.variable) return false;
    const rest = redirects.amps.reduce((s, i) => `${s.slice(0, i)} ${s.slice(i + 1)}`, cmd);
    if (/&/.test(rest.replace(/\d*>&(?:\d+|-)/g, ""))) return false;
    const statements = parseStatements(cmd);
    // Every word is plain here (no `$`, quote, substitution), so an `echo` / `printf` body is literal text whatever the fd spelling.
    if (statements !== null) return statements.length === 1 && ["reader", "runner"].includes(statements[0]?.kind ?? "") && !["echo", "printf"].includes(statements[0]?.words[0] ?? "");
    const words = cmd.replace(REDIRECT, " ").split(/[ \t]+/).filter(Boolean);
    return isGitReport(words);
  } catch {
    return false;
  }
}

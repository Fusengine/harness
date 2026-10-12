import { CMD } from "./bash-command-anchor";
import { perlCarriesInPlace } from "./bash-write-perl";

export {
  RUBY_WRITES, JS_RUNTIME_WRITES, INLINE_JS_ANCHOR, INLINE_JS_STDIN_ANCHOR, PERL_E_ANCHOR, PERL_WRITES,
  RUBY_E_ANCHOR, NODE_WRITES,
} from "./bash-write-inline";

/** Code-file extensions the write guards police (shared by CODE_REDIRECT and
 *  CODE_COMMAND_WRITE). Widened (bypass #9 closure, 2026-09-05 challenger)
 *  with `mts|cts|mjs|cjs` (TS/JS's explicit-module-kind extensions — absent
 *  before, so `writeFileSync("a.mts")`/`"a.cjs"` fell through as non-code)
 *  and `dart`, for parity with the extension list in file-size-scope.ts.
 *  Matched case-insensitively by every consumer below (`i` flag) — parity
 *  {@link CODE_FILE_LITERAL}'s own bypass #7 closure. */
const CODE_EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|php|swift|dart|vue|svelte|astro|css|c|cpp|h";

/** Redirect (`>`/`>>`) targeting a code-file extension. Case-insensitive
 *  (bypass #9 closure, 2026-09-05 challenger), for parity with
 *  {@link CODE_COMMAND_WRITE} and {@link CODE_FILE_LITERAL}: an upper-cased
 *  extension (`.TS`) still overwrites the same code file on a
 *  case-insensitive filesystem (APFS default). */
export const CODE_REDIRECT: RegExp = new RegExp(`(?:>>?)\\s*[^\\s|;&]*\\.(?:${CODE_EXT})\\b`, "i");

/**
 * A code-file extension named ANYWHERE in an inline script string (typically a
 * path argument to a write API) — parity {@link CODE_REDIRECT} but without the
 * leading `>`/`>>`, since the target here is a function-call argument, not a
 * shell redirect. Reuses {@link CODE_EXT} so both stay in lockstep.
 */
// `i` flag (bypass #7 closure): a case-varied extension (`.TS`, `.Rb`) still
// overwrites the same code file on a case-insensitive filesystem (APFS
// default) — a bare-case regex used to let `writeFileSync("src/x.TS")` slip
// past as a "non-code" ask instead of a hard block.
export const CODE_FILE_LITERAL: RegExp = new RegExp(`\\.(?:${CODE_EXT})\\b`, "i");

/**
 * Interpreters / tools that mutate source in place, plus heredoc-into-file —
 * split into labeled sub-patterns (parity bash-write-guard.py `DENY_PATTERNS`,
 * each with its own `desc`) so the deny reason names which motif matched
 * instead of a single generic message. Every command-named motif is
 * {@link CMD}-anchored (start/separator + optional wrapper chain); only the
 * structural heredoc-into-file motif is position-free.
 */
export const CODE_MUTATORS: readonly (
  | { re: RegExp; desc: string; matches?: undefined }
  | { matches: (cmd: string) => boolean; desc: string; re?: undefined }
)[] = [
  { re: new RegExp(`${CMD}python3?\\s+-\\s*<<`), desc: "Python heredoc input" },
  { re: new RegExp(`${CMD}sed\\b[^|]*\\s-i`), desc: "sed in-place edit" },
  // ae977a9's verdict, except for the narrow spec in bash-write-perl.ts (which owns the legacy regex).
  { matches: perlCarriesInPlace, desc: "perl in-place edit" },
  { re: new RegExp(`${CMD}awk\\b[^|]*-i\\s*inplace`), desc: "awk in-place edit" },
  // `patch` as a command token (start/separator + optional wrapper chain), then a
  // metachar/space/EOL. Never the bare word merely NAMING a path in a read-only
  // command (`jq . apply-patch.json`, `grep patch src/`). Prefix-wrapped forms
  // (`env patch`, `timeout 5 patch`) are now DENIED — the previously accepted gap
  // was closed (owner decision 2026-07-06): the wrapper chain folds into CMD.
  { re: new RegExp(`${CMD}patch(?=\\s|<|[;&|)>]|$)`), desc: "patch file modification" },
  { re: /<<[-~]?\s*['"]?\w+['"]?[\s\S]*?>/, desc: "heredoc redirected into a file" },
];

/**
 * `tee`/`dd of=` whose TARGET is a code file — the command-form parallel to
 * CODE_REDIRECT. {@link CMD}-anchored so `env`/`timeout` wrappers don't shield
 * it; the `tee` branch scans ALL args up to the next `;&|` separator so a
 * decoy-first-target (`tee log.txt src/x.ts`) can't hide the code write. A tee
 * to a NON-code target (`cmd | tee results.txt`) does not match — it stays a
 * plain ASK_WRITERS ask, never a hard block, so ordinary logging is untouched.
 * Case-insensitive (bypass #9 closure, 2026-09-05 challenger): a bare-case
 * match let `tee src/a.TS` fall through to the generic ASK_WRITERS "tee to
 * file" ask instead of this hard BLOCK, since an upper-cased extension still
 * overwrites the same code file on a case-insensitive filesystem (APFS
 * default).
 */
export const CODE_COMMAND_WRITE: RegExp = new RegExp(
  `${CMD}(?:tee\\s+[^;&|\\n]*?|dd\\b[^|]*\\bof=\\S*)\\.(?:${CODE_EXT})\\b`,
  "i",
);

/**
 * Command-position anchor for `python3 -c` (same anchored-token shape as the
 * removed unconditional CODE_MUTATORS entry) — used ONLY to gate {@link PYTHON_WRITES}
 * below, never as a standalone block. `python3 - <<EOF` (heredoc) stays
 * unconditionally blocked in CODE_MUTATORS — a heredoc body can't be inspected
 * reliably with a single-line regex, so it is never widened.
 */
export const PYTHON_C_ANCHOR: RegExp = new RegExp(`${CMD}python3?\\s+-c\\b`);

/**
 * File/process-mutating constructs inside a `python3 -c` inline script (parity
 * NODE_WRITES/RUBY_WRITES: content-gated, not name-gated). `python3 -c` is
 * blocked ONLY when this matches — a read-only one-liner (`print(...)`,
 * `json.load`/`json.dumps`) passes. Doc-verified against docs.python.org
 * (functions/pathlib/shutil/subprocess/os/pickle) before writing this pattern.
 *
 * Families, each independently sufficient to mutate state or run arbitrary code:
 *  - `open(...)` / `Path(...).open(...)` in a write/append/exclusive/read-write
 *    mode — positional (`'w'`,`'x'`,`'a'`,`'r+'`,`'w+'`, …) or `mode=` kwarg, any
 *    `b`/`t` suffix. Plain `open(f)` / `open(f, 'r')` (read-only, the default)
 *    does NOT match.
 *  - `pathlib.Path` mutators: `write_text`, `write_bytes`, `unlink`, `rename`,
 *    `replace`, `mkdir`, `rmdir`, `touch`, `chmod`, `symlink_to`, `hardlink_to`,
 *    plus 3.14+ `move`, `move_into`, `copy`, `copy_into`.
 *  - `shutil.*` EXCLUDING the confirmed read-only members `which`,
 *    `disk_usage`, `get_terminal_size`, `get_archive_formats`,
 *    `get_unpack_formats` — every other shutil function copies/moves/deletes.
 *  - `os.*` mutators/exec: `remove`, `unlink`, `rename`, `replace`, `makedirs`,
 *    `mkdir`, `rmdir`, `removedirs`, `chmod`, `chown`, `symlink`, `link`,
 *    `truncate`, `chdir`, `fchdir`, `putenv`, `write`, `ftruncate`, `fchmod`,
 *    `fchown`, `fork`, `system`, `popen`, plus the `exec*`/`spawn*`/
 *    `posix_spawn` families.
 *  - `subprocess.run|call|check_call|check_output|Popen|getoutput|getstatusoutput`
 *    — the actual spawn surface. Non-spawning members (`PIPE`, `DEVNULL`,
 *    `STDOUT`, `CompletedProcess`, `CalledProcessError`, …) are deliberately
 *    excluded — a bare `subprocess\.\w+` would false-positive on those.
 *  - `pickle.dump` / `json.dump` (the file-writing form — `\b` after `dump`
 *    excludes `dumps`, which only serializes to a string/bytes in memory).
 *  - `csv.writer`, `tempfile.*` (temp-file/dir creation is still a write).
 *  - generic `.write(`/`.writelines(` — covers any file-like object, including
 *    one opened via a variable this static check can't trace back to `open()`.
 *  - `exec(`/`eval(` — arbitrary code execution, not merely file I/O.
 *
 * Deliberately NOT included: bare `import` statements, arithmetic/string
 * formatting, `print`, `json.load`/`json.loads`, `sys.argv`/`os.environ` reads,
 * `os.getcwd`/`os.listdir`/`os.path.*` — none of these mutate disk or spawn.
 */
export const PYTHON_WRITES: RegExp = new RegExp(
  "\\bopen\\s*\\([^)]*(?:(['\"])(?:[wax]|r\\+|\\+r)[bt]?\\1|mode\\s*=\\s*(['\"])(?:[wax]|r\\+|\\+r)[bt]?\\2)"
    + "|\\.(?:write_text|write_bytes|unlink|rename|replace|mkdir|rmdir|touch|chmod|symlink_to|hardlink_to"
    + "|move_into|copy_into|move|copy|write|writelines)\\s*\\("
    + "|\\bshutil\\.(?!which\\b|disk_usage\\b|get_terminal_size\\b|get_archive_formats\\b|get_unpack_formats\\b)\\w+"
    + "|\\bos\\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|system|popen|chmod|chown|symlink"
    + "|link|truncate|chdir|fchdir|putenv|write|ftruncate|fchmod|fchown|fork)\\b"
    + "|\\bos\\.(?:exec|spawn|posix_spawn)\\w*\\b"
    + "|\\bsubprocess\\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\\b"
    + "|\\bpickle\\.dump\\b"
    + "|\\bjson\\.dump\\b"
    + "|\\bcsv\\.writer\\b"
    + "|\\btempfile\\.\\w+"
    + "|\\b(?:exec|eval)\\s*\\(",
);

/** Redirect to a non-code file. Excludes `/dev/null`, `2>`/`N>` and `>&N` fd
 * redirects via the `(?<![0-9&])` lookbehind + `(?!…|&)` (parity has_file_redirect). */
export const FILE_REDIRECT: RegExp =
  /(?<![0-9&])\s*>>?\s*(?!\/dev\/null|&)[a-zA-Z./~$]/;

/** Other ambiguous file writers (ASK): `tee <file>` (not `tee -a`/path) and `dd … of=` —
 * labeled sub-patterns (parity bash-write-guard.py `ASK_PATTERNS`). */
export const ASK_WRITERS: readonly { re: RegExp; desc: string }[] = [
  { re: /\btee\s+[^-/\s]/, desc: "tee to file" },
  { re: /\bdd\b[^|]*\bof=/, desc: "dd output to file" },
];

/** Commands whose first token never writes, skipped when a real redirect is
 * present (parity bash-write-guard.py `SAFE_PREFIXES`). */
export const SAFE_PREFIXES: readonly string[] = [
  "ls", "pwd", "which", "cat ", "head ", "tail ", "wc ", "file ", "stat ", "tree", "du ", "df ",
  "find ", "grep ", "rg ", "git ", "cd ", "source ", "export ", "unset ", "env ", "printenv",
  "bun test", "bun run", "bunx ", "npm test", "npm run", "npx ", "biome ", "eslint ",
  "prettier ", "ruff ", "pyright ", "tsc ", "mkdir ", "mv ", "cp ",
];

/**
 * Session-state directory the freshness/APEX gates rely on. Any Bash command
 * touching it is a hook-bypass vector, so it is blocked outright — a blunt
 * substring match (read OR write), parity with bash-write-guard.py DENY_PATTERNS
 * `fusengine-cache/sessions` (rebranded to the harness cache path).
 */
export const SESSION_STATE_FRAGMENT = ".fuse-harness/cache/sessions";

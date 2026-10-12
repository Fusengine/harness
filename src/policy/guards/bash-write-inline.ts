import { CMD } from "./bash-command-anchor";

/**
 * JS/perl inline-script anchors and write-API detectors, split out of
 * bash-write-patterns.ts to keep it under the 200-line SOLID ceiling.
 * Re-exported from bash-write-patterns.ts so no import site elsewhere
 * changes.
 */

/** File-mutating one-liners via `node -e` / `ruby -e` (parity NODE_WRITES/RUBY_WRITES).
 *  Re-exported (parity main, restored 2026-09-05 Break 3 fix): the unanchored
 *  fallback ask-tier in bash-write.ts still consumes it directly, and it also
 *  feeds {@link JS_RUNTIME_WRITES} below. */
export const NODE_WRITES: RegExp =
  /writeFile|appendFile|createWriteStream|fs\.(?:write|rename|unlink|mkdir|rmdir|copyFile)|execSync|spawnSync|child_process/;
export const RUBY_WRITES: RegExp =
  /File\.(?:write|open|delete|rename)|Dir\.(?:mkdir|rmdir|delete|unlink)|IO\.write|FileUtils|\bsystem\b|\bexec\b|`[^`]/;

/**
 * File-mutating / process-spawning constructs inside a `node`/`bun -e`/`deno eval`
 * inline script (parity NODE_WRITES, widened to Bun/Deno runtime APIs, plus
 * bypass #6 closure): `Bun.write`/`spawn`/`spawnSync`/`$`/`file(...).writer`,
 * `Deno.*` file-mutation + `Deno.open`/`writeSync`, and bare alias-safe
 * `writeFileSync`/`openSync`/`writeSync`/`appendFileSync`/`rmSync`/
 * `unlinkSync`/`renameSync`/`mkdirSync`/`copyFileSync`/`truncateSync`/
 * `createWriteStream` calls — these fire even when imported without an
 * `fs.` prefix (`import { writeFileSync } from "node:fs"`), which
 * {@link NODE_WRITES}'s `fs\.` -prefixed alternatives alone miss. Also
 * widened (bypass #9 closure, 2026-09-05 challenger) for `fs`/`fs/promises`
 * `open(...)` (same mode-gated shape as `PYTHON_WRITES`' `open(...)`:
 * `w`/`a`/`x`/`r+` mode string), plus a co-occurrence check for a
 * `FileHandle.write(...)` call in the SAME command as an `open(...)` call —
 * `(await import("node:fs/promises")).open(p,"w")` then `fh.write(...)`
 * previously slipped past because a mode-less `open(p, flags)` plus a later
 * `.write(` had no single alternative to catch it. Both new alternatives are
 * bounded/lazy with no nested quantifiers (linear-time, ReDoS-safe).
 */
export const JS_RUNTIME_WRITES: RegExp = new RegExp(
  `${NODE_WRITES.source}`
    + "|Bun\\.(?:write|spawn|spawnSync|\\$)"
    + "|Bun\\.file\\([^)]*\\)\\.writer"
    + "|Deno\\.(?:writeTextFile|writeFile|writeTextFileSync|writeFileSync|remove|rename|mkdir|create|run|Command|open|writeSync)"
    + "|\\b(?:openSync|writeSync|writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|mkdirSync|copyFileSync|truncateSync|createWriteStream)\\b"
    + "|\\bopen\\s*\\([^)]*['\"](?:[wax]|r\\+)[^'\"]*['\"]"
    + "|\\bopen\\s*\\([^)]*\\)[\\s\\S]*?\\.write\\s*\\(",
);

/**
 * Command-position anchor for inline JS/TS one-liners: `node`/`bun`/`tsx`/
 * `ts-node -e`/`--eval`/`-p`/`--print` (also `--eval=value`), `deno eval`, or
 * the same runtimes invoked via `bunx`/`bun x`/`npx` (bypass #5 closure).
 * Widened (bypass #3 closure) to allow interpreter OPTIONS between the
 * runtime token and the eval flag — `node --input-type=module -e …`,
 * `node -r ./p.cjs -e …` — via a lazy `(?:\s+-\S+(?:\s+[^-\s;&|]\S*)?)*?`
 * that consumes ≥2 chars per iteration (no zero-width repetition, no nested
 * unbounded quantifier — safe against ReDoS). Also widened (bypass #9
 * closure, 2026-09-05 challenger) with a glued single-dash SHORT-OPTION
 * CLUSTER alternative `-[a-zA-Z]*[ep][a-zA-Z]*\b`: node/bun accept clustered
 * short flags (`node -pe '...'`, `bun -pe '...'`), so an eval/print flag
 * fused with another single-letter option (`-pe`, `-npe`) previously slipped
 * past the exact `-e|--eval|-p|--print` literal alternation. The cluster
 * form requires the SINGLE leading dash (never `--`, so `--version`'s second
 * dash breaks the match) and at least one `e`/`p` anywhere in the cluster —
 * `node -v`/`bun -h`/`node --version` contain neither and stay unanchored.
 * Two adjacent `[a-zA-Z]*` around a fixed `[ep]` class is linear-time (each
 * failed split backtracks by one position, no nested star), so this stays
 * safe against ReDoS on a long garbage-letter cluster. Used ONLY to gate
 * {@link JS_RUNTIME_WRITES} below, never as a standalone block; {@link CMD}-
 * anchored so a transparent wrapper doesn't shield it while a quoted/argument
 * MENTION never matches (never at a command position).
 */
const INLINE_JS_RUNTIME = "(?:(?:bunx|bun\\s+x|npx)\\s+(?:tsx|ts-node)|node|bun|tsx|ts-node)";
export const INLINE_JS_ANCHOR: RegExp = new RegExp(
  `${CMD}(?:${INLINE_JS_RUNTIME}\\b(?:\\s+-\\S+(?:\\s+[^-\\s;&|]\\S*)?)*?\\s+(?:-e|--eval|-p|--print|-[a-zA-Z]*[ep][a-zA-Z]*\\b)(?:=|\\s)|deno\\s+eval\\b)`,
);

/**
 * Command-position anchor for a JS/TS script piped via STDIN (bypass #1
 * closure): `node -`, `bun -`, `bun run -`, `deno run -A -` (any options
 * before the trailing `-`), `tsx -`, `ts-node -`. The trailing `-` must be a
 * LONE token (`\s+-(?=\s|$)`) so `node -e`/`node -flag` are never
 * double-matched here — those are {@link INLINE_JS_ANCHOR}'s job. The
 * heredoc/piped BODY is part of `command` (the shell already inlined it
 * before the tool ever saw it), so {@link JS_RUNTIME_WRITES} and
 * `CODE_FILE_LITERAL` scanning the raw command string already see it — no
 * separate body extraction needed. `cat file.js | node -` with no visible
 * write API stays allow: equivalent to `node file.js`, the actual script
 * lives off-command in `file.js` and is inherently unpoliceable by a static
 * regex over the command line.
 *
 * Widened (2026-09-05 challenger fix) to also anchor `ruby -` / `perl -`
 * stdin scripts — no rename needed, this constant already covers "any
 * interpreter piped a script via stdin", not just JS/TS runtimes. Gated in
 * bash-write.ts on `JS_RUNTIME_WRITES.test(cmd) || RUBY_WRITES.test(cmd) ||
 * PERL_WRITES.test(cmd)` so a Ruby/Perl stdin script is checked against its
 * own write-API set, not JS's.
 */
export const INLINE_JS_STDIN_ANCHOR: RegExp = new RegExp(
  `${CMD}(?:node|bun(?:\\s+run)?|deno\\s+run(?:\\s+-\\S+)*|tsx|ts-node|ruby|perl)\\s+-(?=\\s|$)`,
);

/**
 * Command-position anchor for `perl -e` style inline scripts (bypass #8
 * closure), gating {@link PERL_WRITES} below. `-[a-zA-Z]*[eE]\b` matches any
 * single-letter-switch CLUSTER containing `e` OR `E` (`-e`, `-pe`, `-ne`,
 * `-pie`, perlrun's documented clustering rule) — the `E` case (bypass #9
 * closure, 2026-09-05 challenger) is perl's "-E" form, which enables `-e`
 * PLUS modern features (`say`, `state`, etc.) and clusters the same way
 * (`-nE`, `-plE`), so a bare-case check let `perl -E '...'` slip past
 * unanchored. Fires on script content this static check CAN inspect. The
 * CODE_MUTATORS "perl in-place edit" entry (perlCarriesInPlace,
 * bash-write-perl.ts) stays a separate motif, checked before this one.
 */
export const PERL_E_ANCHOR: RegExp = new RegExp(`${CMD}perl\\s+-[a-zA-Z]*[eE]\\b`);

/**
 * Command-position anchor for `ruby -e` style inline scripts (Break 1 fix,
 * 2026-09-05 owner-measured parity gap), same shape as {@link PERL_E_ANCHOR}/
 * {@link INLINE_JS_ANCHOR}. The prior `ruby -e` detector was a bare
 * `/\bruby\s+-e\b/` with no {@link CMD} anchor and no option-awareness: it
 * fired on any command POSITION (including inside a quoted mention —
 * `git commit -m "block ruby -e File.write to src/x.ts"`) and missed real
 * invocations with interpreter options before the eval flag
 * (`ruby -ryaml -e …`) or a glued short-option cluster (`ruby -we …`,
 * `ruby -ne …`, `ruby --disable=gems -e …`). This anchor requires
 * start/separator + optional wrapper chain ({@link CMD}), then `ruby\b`, then
 * a lazy non-zero-width options run `(?:\s+-\S+(?:\s+[^-\s;&|]\S*)?)*?`
 * (each iteration consumes ≥2 chars — linear-time, ReDoS-safe, identical
 * shape already proven by {@link INLINE_JS_ANCHOR}), then the eval flag
 * itself `-[a-zA-Z]*e\b` (a single leading dash, any letters, then a
 * mandatory `e`) — matching `-e`, `-we`, `-ne`, or a separate `-e` token
 * after `-ryaml`/`--disable=gems`. `ruby -v`/`ruby --version` never reach a
 * trailing `e`-bearing flag this way and stay unanchored. Used ONLY to gate
 * {@link RUBY_WRITES} above, never as a standalone block; a quoted/argument
 * mention is never at a command position, so it never matches here — such a
 * mention may still be caught by the separate unanchored ask-tier fallback
 * restored in bash-write.ts (parity main), which fires only when nothing
 * anchored matched and SAFE_PREFIXES didn't already short-circuit.
 */
export const RUBY_E_ANCHOR: RegExp = new RegExp(`${CMD}ruby\\b(?:\\s+-\\S+(?:\\s+[^-\\s;&|]\\S*)?)*?\\s+-[a-zA-Z]*e\\b`);

/**
 * File-mutating / process-spawning constructs inside a `perl -e` inline
 * script (bypass #8 closure, parity {@link RUBY_WRITES}): `open(...)` in a
 * write/append mode (`>`, `>>`), `unlink`, `rename`, `File::Copy`/
 * `File::Path`/`File::Temp`, `system`, `exec`, or a backtick shell-out. A
 * read-only one-liner (`print(...)`, `open($fh,'<',$f)`) does not match.
 */
export const PERL_WRITES: RegExp =
  /open\s*\([^)]*['"]\s*>|\bunlink\b|\brename\b|File::(?:Copy|Path|Temp)|\bsystem\b|\bexec\b|`[^`]/;

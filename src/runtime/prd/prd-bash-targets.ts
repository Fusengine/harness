/**
 * @module prd-bash-targets
 * Local, PRD-module-only extension of Bash write-target detection BEYOND
 * shell output redirects (`>`/`>>`, already covered by `shellOutputRedirects`
 * in `bash-write-redirects.ts`). Static, best-effort heuristic scanner (never
 * executes the command) for the write-target argument of common non-redirect
 * write verbs: `cp`, `mv`, `install` (last positional = destination), `tee`
 * (every positional = a destination), `sed -i` / `perl -i` (in-place edit —
 * last positional = the edited file), and `dd of=` (the `of=` operand).
 *
 * Deliberately NOT merged into `bash-write-redirects.ts` or
 * `protectedPathGuard` (`protected-path.ts`) — both are shared, harness-wide
 * guards; changing them risks a global regression. This is a narrow,
 * PRD-scoped sibling used ONLY by `prdPreGate`'s Bash branch, feeding its
 * output through the SAME `isPrdScopedPath` check the redirect targets
 * already go through — so a target outside the PRD tree is never affected.
 *
 * Known limitation: `--` (POSIX end-of-options, GNU coreutils/glibc
 * `getopt_long`) is honored — a positional arg starting with `-` AFTER `--`
 * is never mistaken for an option — but `getopt_long`'s default PERMUTE mode
 * lets a value-taking option (`install -m 644 file dest`, `cp -t DIR a b`)
 * land anywhere in argv; this scanner doesn't track which options consume a
 * following value, so a bare value like `644` could in principle be
 * mistaken for the destination if it were the LAST token. Best-effort only
 * (mirrors the existing `protectedPathGuard#extractWriteTargets`
 * precedent): can under/mis-detect an unusual invocation, never cause a
 * false deny on an out-of-scope path (the caller still scope-checks every
 * returned target). Not applied to `dd`, whose `if=`/`of=` operands are
 * never getopt-parsed (coreutils docs: "the only options are
 * --help/--version").
 *
 * 2nd limitation (unfixed, flagged for owner): bundled `-i` (`perl -pi -e`,
 * `sed -ni`) is missed — only a standalone `-i`/`-i<suffix>` token is seen.
 */

/** Chain separators this splits a command on (quote/paren-depth aware — never splits inside quotes or `$(...)`/backticks). */
const CHAIN_CHARS = new Set([";", "&", "|", "\n"]);

/** Balanced-paren scan for a `$(...)` body, quote-aware. @returns Index of the matching `)`, or `input.length` if unterminated. */
function closingParen(input: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return input.length;
}

/**
 * Splits `input[start, end)` into "simple command" strings on unquoted chain
 * separators, recursing into `$(...)`/backtick substitutions so a write verb
 * hidden inside a subshell is still found. Bounded: every recursive call
 * strictly narrows `[start, end)`.
 * @param out - Accumulator for discovered simple-command strings.
 */
function scanCommands(input: string, start: number, end: number, out: string[]): void {
  let cmdStart = start;
  let quote: "'" | '"' | null = null;
  const flush = (to: number): void => {
    const seg = input.slice(cmdStart, to).trim();
    if (seg) out.push(seg);
  };
  for (let i = start; i < end; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    // Single quotes are fully opaque (bash: NO substitution inside `'...'`).
    // Double quotes still perform command substitution (bash: `"$(...)"` and
    // `` "`...`" `` both still execute) — only word-splitting/globbing is
    // suppressed — so `$(`/backtick must still be checked while `quote==='"'`.
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === "$" && input[i + 1] === "(") {
      const close = closingParen(input, i + 2);
      scanCommands(input, i + 2, close, out);
      i = close;
      continue;
    }
    if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      const safeClose = close === -1 || close > end ? end : close;
      scanCommands(input, i + 1, safeClose, out);
      i = safeClose;
      continue;
    }
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (CHAIN_CHARS.has(ch ?? "")) {
      flush(i);
      cmdStart = i + 1;
      continue;
    }
  }
  flush(end);
}

/**
 * Tokenizes one simple-command string into unquoted words (quotes unwrapped,
 * backslash-escapes resolved outside single quotes) — same unquoting
 * contract as `bash-write-redirect-op.ts`'s own `readTarget`.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (ch === "\\" && quote !== "'") {
      if (i + 1 < segment.length) { cur += segment[++i] ?? ""; started = true; }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** True for a short/long option token (never a bare `-`, the stdin/stdout idiom). */
function isOption(t: string): boolean {
  return t.startsWith("-") && t !== "-";
}

/**
 * Positional (non-option) arguments, honoring `--` as POSIX end-of-options
 * (see module doc): every token after a literal `--` is positional even if
 * it starts with `-`.
 */
function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  let optionsEnded = false;
  for (const t of args) {
    if (!optionsEnded && t === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && isOption(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Write-target argument(s) of one verb invocation, given its ARGUMENTS (verb
 * token excluded). Empty when the verb isn't covered, or has no destination.
 * @param verb - The verb basename (leading directory component stripped).
 */
function verbWriteTargets(verb: string, args: string[]): string[] {
  if (verb === "dd") {
    const of = args.find((t) => t.startsWith("of="));
    return of ? [of.slice(3)] : [];
  }
  if (verb === "tee") return positionalArgs(args);
  if (verb === "cp" || verb === "mv" || verb === "install") {
    const p = positionalArgs(args);
    return p.length > 0 ? [p[p.length - 1] ?? ""] : [];
  }
  if (verb === "sed" || verb === "perl") {
    const inPlace = args.some((t) => t.startsWith("-i") || t === "--in-place" || t.startsWith("--in-place="));
    if (!inPlace) return [];
    const p = positionalArgs(args);
    return p.length > 0 ? [p[p.length - 1] ?? ""] : [];
  }
  return [];
}

/**
 * Extracts candidate write-target paths from a Bash command string, for the
 * non-redirect write verbs this module covers (`cp`, `mv`, `install`, `tee`,
 * `sed -i`/`perl -i`, `dd of=`). Read-only usages (a verb that never writes,
 * or a write verb whose only in-scope path is a SOURCE argument) never
 * contribute a target — callers still resolve/scope-check every returned
 * path themselves (this function does no fs access, no scoping decision).
 * @param command - The raw Bash command string.
 * @returns Candidate write-target paths (possibly empty/duplicated).
 */
export function extraBashWriteTargets(command: string): string[] {
  const segments: string[] = [];
  scanCommands(command, 0, command.length, segments);
  const out: string[] = [];
  for (const seg of segments) {
    const tokens = tokenize(seg);
    const verbToken = tokens[0];
    if (!verbToken) continue;
    const verb = verbToken.split("/").pop() ?? verbToken;
    out.push(...verbWriteTargets(verb, tokens.slice(1)));
  }
  return out;
}

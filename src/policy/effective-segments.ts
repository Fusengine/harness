/**
 * @module effective-segments
 * Every simple command a Bash command line really runs, found by descending
 * into the wrappers that hide it: `cd x &&`, env prefixes, `sudo`/`xargs`/`env`
 * and friends, `sh -c '…'` / `bash -c "…"` / `eval …` payloads, text piped into
 * a bare shell, `( … )` / `{ …; }` / `if`/`for`/`while`/`case` bodies, function
 * bodies, `find -exec`, and `$(…)` / backtick / `<(…)` substitutions. Each
 * command is reported in a canonical form (`git push --force origin x`, global
 * options removed) that the git / rm / gh policies match their patterns
 * against. Comments and data heredoc bodies are ignored; heredoc bodies a
 * shell executes are scanned.
 *
 * Fail closed: when the line cannot be fully analysed (depth, visit or character
 * budget exceeded, a shell payload or command word built at run time, a git alias)
 * `opaque` is set.
 */
import { basename } from "node:path";
import { stripDataHeredocs } from "./release-heredoc";
import { shellSegments } from "./motion/shell-verbs";
import { APPENDING, SHELLS, ghParts, gitParts, peel, ungroup } from "./command-peel";
import { SHELL_CODE_OPT, commandWords, isNoExec, shellPayloads, stripComments, substitutions } from "./shell-words";
import { pipedPayloads } from "./shell-pipes";

/** One simple command the line runs. */
export interface Effective {
  /** Basename of the verb (`git`, `rm`, `gh`, `sh`, …). */
  verb: string;
  /** Arguments after the verb (git: subcommand first, global options removed; gh: `pr merge …`). */
  argv: string[];
  /** Canonical text: verb and argv joined by single spaces (an argument holding whitespace stays one quoted unit). */
  text: string;
  /** The segment as written (compound-command dressing removed), for patterns that look at wrappers such as `sudo`. */
  seg: string;
  /** True when a wrapper adds operands of its own to the command (`xargs`, `parallel`, `find -exec … +`). */
  appends: boolean;
}

/** Result of {@link expand}. */
export interface Expansion { items: Effective[]; opaque: boolean }

/** Deepest nesting of payloads / substitutions walked before the line is reported opaque. */
const MAX_DEPTH = 8;
/** Segment visits allowed per reading before the line is reported opaque. */
const MAX_VISITS = 400;
/** Leading `VAR=value` assignments of a segment (quoted, `$(…)`, backtick or bare values). */
const ENV_PREFIX = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|\$\(.*$|`[^`]*`|\S*)(?:\s+|$))+/;
/** Shell code that starts with an expansion or a backtick, so its text is only known at run time. */
const DYNAMIC = /^(?:\$|`)/;
/** A command word or segment that builds the command at run time: `$CMD`, `{git,push}`, `${IFS}` splitting. */
const DYNAMIC_VERB = /^\$\{?\w+\}?$|^\{[^}]*,|\$\{?IFS\b/; // tested on the command word only

/** Longest command (characters) the wrapper-aware walk reads in release mode; longer ones go straight to the merge-base classifier. */
const MAX_RELEASE_WALK = 256 * 1024;
/** In release mode a command with no `gh` / `git` word (quotes and backslashes dropped, no `$'…'`) cannot hold a release step. */
const MAY_RELEASE = /gh|git/;

/** Accumulator shared by one {@link expand} walk. */
interface State {
  items: Effective[];
  opaque: boolean;
  visits: number;
  /** Characters of shell text scanned so far, across BOTH readings. */
  chars: number;
  /** Characters allowed in total: a few passes over the command, so cost stays within a small factor of its length. */
  maxChars: number;
  /** Optional early-exit predicate from {@link expand}: returning true ends the walk at once. */
  stop?: (item: Effective) => boolean;
  /** Set when `stop` fired or (in stop mode) a budget ran out: everything unwinds at once. */
  done: boolean;
}

/** Canonical {@link Effective} of one peeled command (git / gh global options removed). */
function describe(peeled: string[], seg: string, appends: boolean): Effective {
  const verb = basename(peeled[0] ?? "");
  let argv = peeled.slice(1);
  if (verb === "git") {
    const git = gitParts(peeled);
    argv = [git.sub, ...git.args];
  } else if (verb === "gh") {
    const gh = ghParts(peeled);
    argv = [...gh.words, ...gh.args];
  }
  // An argument holding whitespace stays ONE quoted unit, so prose in `-m "…"` / `--grep "…"` never reads as flags.
  const text = [verb, ...argv].filter((t) => t !== "").map((t) => (/\s/.test(t) ? `'${t}'` : t)).join(" ");
  return { verb, argv, text, seg, appends };
}

/** Commands run by `find … -exec <cmd> {} ;|+` (each as its own text), plus `env -S 'cmd'`. */
function embedded(raw: string[]): { text: string; appends: boolean }[] {
  const out: { text: string; appends: boolean }[] = [];
  const verb = basename(raw[0] ?? "");
  raw.forEach((w, i) => {
    if (verb === "find" && /^-(?:exec|execdir|ok|okdir)$/.test(w)) {
      // The command ends at its own terminator or where the next -exec starts (keeps the scan linear).
      let end = i + 1;
      while (end < raw.length && raw[end] !== ";" && raw[end] !== "+" && !/^-(?:exec|execdir|ok|okdir)$/.test(raw[end] ?? "")) end++;
      if (end >= raw.length) end = -1;
      out.push({ text: raw.slice(i + 1, end < 0 ? raw.length : end).join(" "), appends: end >= 0 && raw[end] === "+" });
    }
    if (verb === "env" && (w === "-S" || w === "--split-string") && raw[i + 1]) out.push({ text: raw[i + 1] ?? "", appends: false });
  });
  return out;
}

/** Record every command `text` runs into `st`, descending into substitutions and shell payloads (budgeted). */
function visit(text: string, depth: number, st: State, appends = false): void {
  if (st.done) return;
  st.chars += text.length;
  if (depth > MAX_DEPTH || ++st.visits > MAX_VISITS || st.chars > st.maxChars) {
    st.opaque = true;
    if (st.stop) st.done = true; // stop mode (release gate): the caller falls back to the merge-base classifier at once
    return;
  }
  const pipedFrom: number[] = [];
  const written = shellSegments(text);
  let cursor = 0;
  const ends = written.map((s) => { const at = text.indexOf(s, cursor); cursor = at < 0 ? cursor : at + s.length; return { at, end: cursor }; });
  const grouped = written.map(ungroup);
  const parts = grouped.map((g) => g.replace(ENV_PREFIX, ""));
  for (const [n, seg] of parts.entries()) {
    if (st.done) return;
    // Substitutions of the segment as written (a `case $(…) in` subject is dropped by ungroup).
    for (const body of substitutions(written[n] ?? "")) visit(body, depth + 1, st);
    if (st.done) return;
    if (!seg) continue;
    const raw = commandWords(seg);
    const peeled = peel(raw);
    if (DYNAMIC_VERB.test(raw[0] ?? "")) st.opaque = true;
    for (const e of embedded(raw)) visit(e.text, depth + 1, st, e.appends);
    if (st.done) return;
    if (peeled.length === 0) continue;
    const stripped = raw.slice(0, raw.length - peeled.length).map((w) => basename(w));
    const item = describe(peeled, seg, appends || stripped.some((w) => APPENDING.has(w)));
    st.items.push(item);
    if (st.stop?.(item)) { st.done = true; return; }
    if (item.verb === "git" && peeled.some((w, i) => w === "-c" && /^alias\./.test(peeled[i + 1] ?? ""))) st.opaque = true;
    if (!SHELLS.has(item.verb)) continue;
    const rest = raw.slice(raw.length - peeled.length + 1);
    const found = shellPayloads(item.verb, rest);
    // A bare shell runs what the PREVIOUS segment pipes into it (`echo '…' | sh`); `sh -n` / `--version` run nothing.
    const gap = n > 0 ? text.slice(ends[n - 1]?.end ?? 0, ends[n]?.at ?? 0) : "";
    if (found.length === 0 && item.verb !== "eval" && !isNoExec(rest) && rest.every((t) => t.startsWith("-")) && /^\s*\|(?!\|)\s*$/.test(gap)) pipedFrom.push(n - 1);
    for (const p of found) {
      // Only code handed to the shell (`-c <code>`, `eval <code>`) counts; `bash "$DIR/my script.sh"` is a script path.
      const asCode = item.verb === "eval" || SHELL_CODE_OPT.test(rest[rest.indexOf(p) - 1] ?? "");
      if (asCode && DYNAMIC.test(p.trim())) st.opaque = true;
      visit(p, depth + 1, st);
      if (st.done) return;
    }
  }
  // Allowlist: only echo / printf / a here-string print their words into the pipe (and not when stdout is redirected).
  for (const src of pipedFrom) for (const payload of pipedPayloads(parts[src] ?? "")) visit(payload, depth + 1, st);
}

/** One-entry memo of the last complete (non-stopped) {@link expand} call. */
let last: { command: string; result: Expansion } | undefined;

/**
 * Every simple command `command` runs, wrappers and nested shells included.
 * @param command - Raw Bash command.
 * @param stop - Optional: called on each command as it is found; returning true ends the walk at once (the result is
 *   then partial and not memoised).
 */
export function expand(command: string, stop?: (item: Effective) => boolean): Expansion {
  if (!stop && last?.command === command) return last.result;
  // Release mode only: no `gh` / `git` anywhere (after the quote and backslash stripping the walk itself does) and no
  // `$'…'` / `$"…"` means no release step to find, so skip the walk (the caller then uses the merge-base classifier).
  if (stop && !MAY_RELEASE.test(command.replace(/['"\\]/g, "")) && !/\$['"]/.test(command)) return { items: [], opaque: false };
  // Release mode on an enormous command: the walk costs tens of ns per character against a few ns for the merge-base
  // classifier, so past this size only the classifier answers (never weaker than before; opaque = "not fully read").
  if (stop && command.length > MAX_RELEASE_WALK) return { items: [], opaque: true };
  const st: State = { items: [], opaque: false, visits: 0, chars: 0, maxChars: 4 * command.length + 20000, stop, done: false };
  // Both readings: as written, and without comments (an apostrophe in a comment must not hide later lines). The union
  // can only find MORE commands than either alone, so comment stripping can never hide one.
  const written = stripDataHeredocs(command);
  visit(written, 0, st);
  const bare = stripComments(written);
  // Own visit budget (the second reading must not starve on the first's) but the SAME character budget.
  if (bare !== written) { st.visits = 0; visit(bare, 0, st); }
  const result: Expansion = { items: st.items, opaque: st.opaque };
  if (!stop) last = { command, result };
  return result;
}

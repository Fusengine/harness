import { posix } from "node:path";
import { shellFileWriteRedirects } from "./bash-write-redirects";
import { unquotedShellText } from "./bash-write-unquoted";
import { commandTargets, type Push } from "./protected-path-commands";

/** Shell operators/groupers that each start a new simple command once flattened into `;`. */
const FLATTEN_RE = /\$\(|[\n`()]/g;
/** A command substitution body: `$( … )` (group 1) or `` ` … ` `` (group 2); innermost only (no nested parens). */
const SUBST_RE = /\$\(([^()]*)\)|`([^`]*)`/g;
/** Output/input redirection operators with their (glued or spaced) operand, removed before picking positional arguments. */
const REDIRECT_RE = /\d*&?[<>]+[|&]?\s*\S*/g;
/** A quoted single word with no whitespace, separator or substitution inside: its quotes are only a spelling of the path (`~/.fuse-harness/'.key'`, `".k""ey"`). */
const SIMPLE_QUOTED_RE = /(['"])([^\s'"`;|&<>()]*)\1/g;
/** A backslash escaping an ordinary path character (`\.key`, `state\/x`): the shell drops it. */
const PATH_ESCAPE_RE = /\\([A-Za-z0-9._/-])/g;
/** Stand-in for an escaped space, so `x\ y` stays ONE word (and `rm /tmp/x\ K` is not mistaken for an operand `K`). */
const GLUED_SPACE = "\u0001";

/** Strips surrounding quotes from a captured shell token. */
const unquote = (t: string): string => t.replace(/^['"]|['"]$/g, "");

/**
 * Replace every arithmetic expansion `$(( … ))` (a plain word, never a command) by a placeholder, matching the
 * closing `))` with a parenthesis depth counter so inner parens (`$(( (n+1)*2 ))`, `$(( $(id -u) ))`) stay inside.
 * An unterminated `$((` is left untouched.
 */
function stripArithmetic(text: string): string {
  let out = "", i = 0;
  while (i < text.length) {
    if (!text.startsWith("$((", i)) { out += text[i++]; continue; }
    let depth = 0, j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    if (j >= text.length) { out += text[i++]; continue; }
    out += "SUBST";
    i = j + 1;
  }
  return out;
}

/**
 * Unquote simple quoted words and unescape path characters — but ONLY when the quoting is unambiguous: every quote kind
 * balanced and no escaped quote anywhere. Otherwise the regex could pair the wrong quotes and read quoted TEXT as code,
 * so the command is left as is (a quoted target is then simply not seen — never a false positive).
 */
function spellPaths(text: string): string {
  const count = (re: RegExp): number => (text.match(re) ?? []).length;
  const ambiguous = /\\['"]/.test(text) || count(/"/g) % 2 !== 0 || count(/'/g) % 2 !== 0;
  const plain = ambiguous ? text : text.replace(SIMPLE_QUOTED_RE, "$2");
  return plain.replace(/\\ /g, GLUED_SPACE).replace(PATH_ESCAPE_RE, "$1");
}

/** Collect the write targets of every simple command in `text` (substitutions already replaced by a placeholder word). */
function segments(text: string, push: Push): void {
  // `\;` ends a `find -exec` clause but is NOT a command separator: keep it as a `\` word so later clauses stay in the same `find` command.
  for (const seg of text.replace(/\\;/g, " \\ ").replace(FLATTEN_RE, ";").split(/[;&|\n]+/)) commandTargets(seg.replace(REDIRECT_RE, " ").trim().split(/\s+/), push);
}

/**
 * Precise write targets of a Bash command, used ONLY for the newly protected harness paths (never combined with the
 * legacy heuristics): output redirections (quote-aware lexer, raw text), plus — on the quote-, comment- and
 * heredoc-stripped view, at COMMAND position only — the operands that the command really writes (see
 * {@link commandTargets}). Newlines, `( )`, backticks and `$( )` split commands; substitutions are analysed as their
 * own commands and stand in as one placeholder word; `$(( ))` is a plain word. A quoted or text-only mention
 * (`echo "cp a K"`, a commit heredoc, a `grep` argument) never counts.
 * @param cmd - The raw Bash command.
 * @returns Candidate write targets (quotes and backslashes removed; empty strings and `/dev/null` filtered out).
 */
export function newPathTargets(cmd: string): string[] {
  const out: string[] = [];
  const push: Push = (t) => {
    const v = unquote((t ?? "").trim()).replace(/\\(.)/g, "$1");
    if (v && v !== "/dev/null") out.push(v);
  };
  // Redirects: the quote-aware lexer on the raw text, unless a heredoc is present (its body would be scanned as code: `cat <<'EOF'\necho x > K\nEOF`).
  const heredoc = /<<-?\s*['"\\]?\w/.test(cmd);
  if (!heredoc) for (const redirect of shellFileWriteRedirects(cmd)) push(redirect.target);
  // Arithmetic is replaced on the RAW text: the quote/data stripper would otherwise erase `$((…))` and leave the source as the last word.
  // An ESCAPED `\$(` / backtick is literal text, never a substitution: neutralised first.
  const queue = [unquotedShellText(spellPaths(stripArithmetic(cmd.replace(/\\\$\(/g, "ESCDOLLAR").replace(/\\`/g, "ESCTICK"))))];
  for (let depth = 0; queue.length && depth < 64; depth++) {
    let text = queue.shift() ?? "";
    if (heredoc) for (const redirect of shellFileWriteRedirects(text)) push(redirect.target); // data-stripped view: heredoc bodies are gone
    // Fixpoint: innermost substitutions go first, so a NESTED destination (`$(dirname $(mktemp))`) collapses to one placeholder too.
    for (let prev = ""; prev !== text; ) {
      prev = text;
      text = text.replace(SUBST_RE, (_m, a: string | undefined, b: string | undefined) => { queue.push(a ?? b ?? ""); return "SUBST"; });
    }
    segments(text, push);
  }
  return out;
}

/** Paths under the harness home that an agent must never write: the signed track dir and the HMAC key. */
const NEW_PATH_RES: readonly RegExp[] = [/(?:^|\/)\.fuse-harness\/state(?:\/|$)/i, /(?:^|\/)\.fuse-harness\/\.key\/?$/i];

/**
 * Whether `target` is (or resolves to) the harness state dir or HMAC key. The path is normalised first, so `//`, `/./`
 * and `/x/../` segments cannot hide it; matching is case-insensitive (macOS filesystems are).
 * @param target - A file path from a Write/Edit payload or an extracted Bash write target.
 * @returns `true` when the target is the state dir (or inside it) or the key file.
 */
export function hitsNewPath(target: string): boolean {
  const n = posix.normalize(target.trim().replaceAll(GLUED_SPACE, " "));
  // `~` and `$VAR` only expand at the START of a word: after an escaped space (`/tmp/x\ ~/.fuse-harness/.key`) they are literal directory names.
  const word = n.includes(" ") ? n.slice(n.lastIndexOf(" ") + 1) : n;
  if (n.includes(" ") && /^[~$]/.test(word)) return false;
  return NEW_PATH_RES.some((re) => re.test(n));
}

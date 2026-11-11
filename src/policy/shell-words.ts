/**
 * @module shell-words
 * Lexical helpers for the wrapper-aware policy: POSIX-like word splitting
 * (quotes, backslashes, `$'…'`), comment removal, `$(…)` / backtick / `<(…)`
 * substitution bodies and the code a shell verb runs. Linear time.
 */

/** A `VAR=value` environment assignment word. */
export const ASSIGNMENT: RegExp = /^[A-Za-z_]\w*=/;
/** A shell option word that ends in `c`, so the next word is the code to run (`-c`, `-lc`, `-ec`). */
export const SHELL_CODE_OPT: RegExp = /^-[a-z]*c$/;
/** Single-letter backslash escapes decoded inside `$'…'`. */
const ANSI_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };

/**
 * Bodies of `$(…)`, `<(…)`, `>(…)` and backtick substitutions in `text`, skipping single-quoted spans
 * (an apostrophe inside double quotes is literal). An unclosed one runs to the end (and ends the scan).
 * @param text - Shell text.
 */
export function substitutions(text: string): string[] {
  const out: string[] = [];
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (!double && ch === "'") { single = !single; continue; }
    if (single) continue;
    if (ch === '"') { double = !double; continue; }
    if ((ch === "$" || ch === "<" || ch === ">") && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      if (depth !== 0) break;
      i = j - 1; // skip the body: nested substitutions are found when the body itself is walked (keeps each pass linear)
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      out.push(text.slice(i + 1, end < 0 ? text.length : end));
      if (end < 0) break;
      i = end;
    }
  }
  return out;
}

/**
 * `text` without shell comments (`#` at the start of a word, outside quotes, to the end of the line), so an
 * apostrophe in a comment never opens a quote that hides the lines after it.
 * @param text - Shell text.
 */
export function stripComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote === "'") { out += ch; if (ch === "'") quote = ""; continue; }
    if (ch === "\\") { out += ch + (text[i + 1] ?? ""); i++; continue; }
    if (quote === '"') { out += ch; if (ch === '"') quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1] ?? ""))) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Shell words of one segment with quoting resolved like a POSIX shell: adjacent quoted and
 * unquoted parts join (`'sh -c '\''git x'\'''` is ONE word), backslash escapes the next
 * character, single quotes are literal, double quotes honour `\"` `\\` `\$` `` \` ``, `$'…'`
 * decodes its backslash escapes. An unterminated quote runs to the end.
 * @param segment - One shell segment.
 */
export function shellWords(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (quote === "'") { if (ch === "'") quote = ""; else cur += ch; continue; }
    if (quote === "$'") {
      if (ch === "'") { quote = ""; continue; }
      if (ch !== "\\") { cur += ch; continue; }
      const next = segment[++i] ?? "";
      const hex = next === "x" ? /^[0-9a-fA-F]{1,2}/.exec(segment.slice(i + 1, i + 3))?.[0] : undefined;
      if (hex) { cur += String.fromCharCode(parseInt(hex, 16)); i += hex.length; } else cur += ANSI_ESCAPES[next] ?? next;
      continue;
    }
    if (ch === "\\") {
      const next = segment[i + 1] ?? "";
      if (quote === '"' && !/[$`"\\\n]/.test(next)) cur += ch + next;
      else if (next !== "\n") cur += next;
      started = true;
      i++;
      continue;
    }
    if (quote === '"') { if (ch === '"') quote = ""; else cur += ch; continue; }
    if (ch === "$" && (segment[i + 1] === "'" || segment[i + 1] === '"')) {
      if (segment[i + 1] === "'") quote = "$'"; else quote = '"';
      started = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Words of a segment without its leading `VAR=value` assignments.
 * @param segment - One shell segment.
 */
export function commandWords(segment: string): string[] {
  const w = shellWords(segment);
  let i = 0;
  while (i < w.length && ASSIGNMENT.test(w[i] ?? "")) i++;
  return w.slice(i);
}

/**
 * Shell code a shell verb runs: only the `-c` argument (the words after it and a script path are data);
 * `eval` runs its arguments joined into one line. None when a no-exec option is present (see {@link isNoExec}).
 * @param verb - Basename of the shell verb.
 * @param rest - The words after the verb.
 */
export function shellPayloads(verb: string, rest: readonly string[]): string[] {
  if (isNoExec(rest)) return [];
  // `eval` joins its arguments into ONE command line: that text covers every part, so it is visited once.
  if (verb === "eval") return rest.length > 0 ? [rest.join(" ")] : [];
  // Only the `-c` argument is code; the words after it (`$0`, `$1`…) and a script path are data.
  const at = rest.findIndex((t) => SHELL_CODE_OPT.test(t));
  return at >= 0 && at + 1 < rest.length ? [rest[at + 1] ?? ""] : [];
}

/** A shell option that never executes anything: `-n` (also in a cluster such as `-nc`), `--version`, `--help`. */
const NO_EXEC = /^(?:-[a-z]*n[a-z]*|--version|--help)$/;

/**
 * True when the words after a shell verb contain an option that stops it from executing (`sh -n`, `bash --version`).
 * @param rest - The words after the shell verb.
 */
export function isNoExec(rest: readonly string[]): boolean {
  // Only options BEFORE the `-c` code count: `sh -c 'code' -n` executes (`-n` is then `$0`/data).
  const at = rest.findIndex((t) => SHELL_CODE_OPT.test(t));
  if (at >= 0) return rest.slice(0, at + 1).some((t) => NO_EXEC.test(t));
  const script = rest.findIndex((t) => !t.startsWith("-"));
  return rest.slice(0, script < 0 ? rest.length : script).some((t) => NO_EXEC.test(t));
}

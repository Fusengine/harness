/**
 * Shell word reader for the arguments of ONE `perl` invocation (consumed by
 * bash-write-perl.ts). It does NOT decode shell syntax: decoding bash, zsh and
 * friends faithfully is a losing game (`$'\U2d'`, `$'\cI'`, `$'\e'`, `\M-`,
 * unicode dashes …). Instead "certain" is a strict WHITELIST, and everything
 * outside it makes the whole invocation uncertain — the caller then returns
 * ae977a9's legacy verdict.
 *
 * A word is certain only if it is made solely of:
 *  - unquoted characters in {@link SAFE} (`A-Za-z0-9_./:=,+@%-`),
 *  - plain single-quoted segments free of `\`, newline and `!` (fish reads `\'`
 *    and `\\` inside single quotes as escapes; csh/tcsh expand `!` and reject
 *    newlines in quotes),
 *  - double-quoted segments free of `\`, `$`, backtick, `!` and newline.
 * Anything else (`$'…'`, `$"…"`, any backslash anywhere, `$`,
 * backtick, `{ } * ? [ ] ~ # ! ^`, redirects, non-ASCII, control characters,
 * CR/FF/VT, an unbalanced quote …) is uncertain.
 */

/** One word. */
export interface PerlWord {
  /** Value of the certain part read so far (quotes removed). */
  readonly text: string;
}

/** Result of reading one token. */
export interface PerlToken {
  /** The word read (possibly only its certain prefix), or null at a boundary. */
  readonly word: PerlWord | null;
  /** True when the invocation's argument list ends here. */
  readonly end: boolean;
  /** Position to continue reading from. */
  readonly next: number;
  /** True when something outside the whitelist was met. */
  readonly uncertain: boolean;
}

/** Unquoted characters a certain word may contain. */
const SAFE = /[A-Za-z0-9_./:=,+@%-]/;
/** Command boundaries that end an invocation with certainty. */
const SEPARATORS = "\n;&|)";
const REDIRECT_START = /(?:\d*|&)[<>]/y;

/**
 * Reads the next token of a perl invocation's argument text.
 * @param s - Full command string.
 * @param from - Index to start reading at.
 * @returns The next word, or an end marker (uncertain when the end is a
 *   redirect, `(` or a backtick rather than a plain separator/EOF).
 */
export function readPerlToken(s: string, from: number): PerlToken {
  let start = from;
  while (s[start] === " " || s[start] === "\t") start++;
  const c = s[start];
  if (c === undefined) return { word: null, end: true, next: start, uncertain: false };
  REDIRECT_START.lastIndex = start;
  if (REDIRECT_START.test(s)) return { word: null, end: true, next: start, uncertain: true };
  if (SEPARATORS.includes(c)) return { word: null, end: true, next: start, uncertain: false };
  return readWord(s, start);
}

/** Reads one word from its first char; stops at the first non-whitelisted construct. */
function readWord(s: string, start: number): PerlToken {
  let i = start;
  let text = "";
  const stop = (): PerlToken => ({ word: { text }, end: true, next: s.length, uncertain: true });
  while (i < s.length) {
    const c = s[i] as string;
    if (c === " " || c === "\t" || SEPARATORS.includes(c)) break;
    if (SAFE.test(c)) { text += c; i++; continue; }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0 || /[\\\n!]/.test(s.slice(i + 1, close))) return stop();
      text += s.slice(i + 1, close);
      i = close + 1;
    } else if (c === '"') {
      const close = s.indexOf('"', i + 1);
      const body = close < 0 ? "" : s.slice(i + 1, close);
      if (close < 0 || /[\\$`!\n]/.test(body)) return stop();
      text += body;
      i = close + 1;
    } else {
      return stop();
    }
  }
  return { word: { text }, end: false, next: i, uncertain: false };
}

import type { Unit, WordTok } from "./bash-write-descend-types";
import { closeBacktick, closeParen, readHeredoc } from "./bash-write-descend-util";
import { parseHeredocOperator } from "./bash-write-lexer-heredoc";

const WS = new Set([" ", "\t", "\r"]);
const SEPARATORS = new Set(["\n", ";", "|", "&", "(", ")"]);

/**
 * Tolerant POSIX-ish scanner: splits a command into {@link Unit}s the way the shell would, resolving
 * quotes, comments, backslash-newline, heredocs and here-strings, and collecting every substitution
 * body. It only has to be accurate enough to find the commands that really run; the caller always
 * keeps the verdict of the original text as a floor.
 * @param src - Raw shell command text.
 * @returns The commands in source order.
 */
export function scan(src: string): Unit[] {
  const units: Unit[] = [];
  let cur: Unit | null = null;
  let word: WordTok | null = null;
  let redirPending = false;
  let herePending = false;
  let before = "";
  let last = 0;
  const docs: Array<{ unit: Unit; delim: string; strip: boolean; quoted: boolean }> = [];

  const ensure = (at: number): Unit => (cur ??= { start: at, end: at, argv: [], redirs: [], heredocs: [], hereStrings: [], subs: [], before });
  const endWord = (at: number): void => {
    if (!word) return;
    const u = ensure(word.start);
    if (redirPending) u.redirs.push(word);
    else if (herePending) u.hereStrings.push(word);
    else u.argv.push(word);
    redirPending = herePending = false;
    last = u.end = at;
    word = null;
  };
  const endUnit = (op: string): void => {
    if (cur) units.push(cur);
    cur = null;
    redirPending = herePending = false;
    before = op;
  };
  const append = (at: number, raw: string, value: string, dynamic: boolean, quoted: boolean): WordTok => {
    word ??= { raw: "", value: "", dynamic: false, quoted: false, start: at };
    word.raw += raw;
    word.value += value;
    word.dynamic ||= dynamic;
    word.quoted ||= quoted;
    return word;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const at = i;
    if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
    if (WS.has(c)) { endWord(i); i++; continue; }
    if (c === "\\") { append(i, src.slice(i, i + 2), src[i + 1] ?? "", false, true); i += 2; continue; }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const end = e < 0 ? src.length : e;
      append(i, src.slice(i, end + 1), src.slice(i + 1, end), false, true);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1, dyn = false;
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j];
        if (d === "\\") { j++; continue; }
        if (d === "$" && src[j + 1] === "(") { const e = closeParen(src, j + 2); if (src[j + 2] !== "(") ensure(at).subs.push(src.slice(j + 2, e)); j = e; dyn = true; continue; }
        if (d === "`") { const e = closeBacktick(src, j + 1); ensure(at).subs.push(src.slice(j + 1, e)); j = e; dyn = true; continue; }
        if (d === "$") dyn = true;
      }
      append(i, src.slice(i, j + 1), src.slice(i + 1, j), dyn, true);
      i = j + 1;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && src[i + 1] === "(") {
      const e = closeParen(src, i + 2);
      const body = src.slice(i + 2, e);
      if (!(c === "$" && src[i + 2] === "(")) ensure(at).subs.push(body); // `$(( … ))` is arithmetic, not a command
      const w = append(i, src.slice(i, e + 1), src.slice(i, e + 1), true, false);
      if (w.start === at && c !== "$") w.proc = body;
      i = e + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;
      for (; j < src.length && src[j] !== "'"; j++) if (src[j] === "\\") j++;
      // `$'cp'` without escapes is plain text; with escapes (`$'\x63p'`) the real text is unknown.
      append(i, src.slice(i, j + 1), src.slice(i + 2, j), src.slice(i + 2, j).includes("\\"), true);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const e = closeBacktick(src, i + 1);
      ensure(at).subs.push(src.slice(i + 1, e));
      append(i, src.slice(i, e + 1), src.slice(i, e + 1), true, false);
      i = e + 1;
      continue;
    }
    if (c === "#" && !word) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      const hd = c === "<" ? parseHeredocOperator(src, i) : null;
      if (hd) {
        endWord(i);
        const u = ensure(i);
        docs.push({ unit: u, delim: hd.word, strip: hd.stripTabs, quoted: /['"\\]/.test(src.slice(i + 2, hd.tokenEnd)) });
        i = last = u.end = hd.tokenEnd;
        continue;
      }
      if (src.startsWith("<<<", i)) { endWord(i); ensure(i); herePending = true; i += 3; continue; }
      const fd = word && /^\d+$/.test((word as WordTok).raw);
      if (fd) word = null; else endWord(i);
      let j = i + (c === "&" ? 2 : 1);
      if (c !== "&" && (src[j] === ">" || src[j] === "|") && src[j - 1] === ">") j++;
      const dup = c === "<" ? null : /^&(?:\d+|-)/.exec(src.slice(j));
      if (dup) { i = j + dup[0].length; if (cur) last = (cur as Unit).end = i; continue; }
      ensure(i);
      redirPending = true;
      i = j;
      continue;
    }
    if (SEPARATORS.has(c)) {
      endWord(i);
      const two = src.slice(i, i + 2);
      const op = two === ";;" || two === "&&" || two === "||" || two === "|&" ? two : c;
      if (cur) (cur as Unit).end = Math.max((cur as Unit).end, last);
      endUnit(op === "|&" ? "|" : op);
      i += op.length;
      if (c === "\n") {
        for (const d of docs.splice(0)) {
          const h = readHeredoc(src, i, d.delim, d.strip);
          d.unit.heredocs.push({ raw: h.raw, body: h.body, quoted: d.quoted });
          i = h.next;
        }
      }
      continue;
    }
    append(i, c, c, c === "$", false);
    i++;
  }
  endWord(src.length);
  if (cur) (cur as Unit).end = Math.max((cur as Unit).end, last);
  endUnit("");
  return units;
}

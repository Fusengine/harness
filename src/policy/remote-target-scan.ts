import type { ScanWord, ShSegment, ShWord } from "./interfaces/remote-target";

/** Characters after `$` that start a parameter expansion (so the word is expanded by the local shell). */
const EXPANDS = /[A-Za-z_0-9@*#?!${-]/;
/** Characters that make an unquoted word subject to local glob / brace expansion. */
const GLOBBY = /[*?[{]/;

/** End index of the redirect operator starting at `i` (`>` `>>` `>|` `>&` `<` `<<` `<<-` `<<<` `<&` `<>` `&>` `&>>`). */
function operatorEnd(cmd: string, i: number): number {
  const c = cmd.charAt(i);
  const n = cmd.charAt(i + 1);
  if (c === "&") return i + (cmd.charAt(i + 2) === ">" ? 3 : 2);
  if (c === "<" && n === "<") return i + (cmd.charAt(i + 2) === "<" || cmd.charAt(i + 2) === "-" ? 3 : 2);
  if (n === c || n === "&" || (c === ">" && n === "|") || (c === "<" && n === ">")) return i + 2;
  return i + 1;
}

/**
 * Split a Bash command into simple-command segments, conservatively. Returns null (caller keeps today's
 * verdict) on anything it does not model: unbalanced quotes, `$(`, backticks, `(`/`)`, `$'`/`$"`, process
 * substitution, backslash-newline, a heredoc or here-string.
 * @param cmd - Raw command string.
 */
export function scanShell(cmd: string): ShSegment[] | null {
  const segs: ShSegment[] = [];
  let seg: ShSegment = { words: [], redirs: [] };
  let w = null as ScanWord | null;
  let target = false;
  let i = 0;
  const flush = (end: number): boolean => {
    if (!w) return true;
    const word: ShWord = { start: w.start, end, text: w.text, dynamic: w.dynamic };
    w = null;
    if (!target) { seg.words.push(word); return true; }
    target = false;
    seg.redirs.push({ start: word.start, end });
    return true;
  };
  const endSeg = (): void => {
    if (seg.words.length || seg.redirs.length) segs.push(seg);
    seg = { words: [], redirs: [] };
    target = false;
  };
  /** Append decoded text to the current word; `plain` keeps the all-digits (redirect fd prefix) tracking alive. */
  const add = (s: string, dyn = false, plain = false): void => {
    const cur = (w ??= { start: i, text: "", dynamic: false, digits: true });
    cur.text += s;
    cur.dynamic ||= dyn;
    cur.digits = cur.digits && plain && /^\d+$/.test(s);
  };
  while (i < cmd.length) {
    const c = cmd.charAt(i);
    const n = cmd.charAt(i + 1);
    if (c === " " || c === "\t" || c === "\n") {
      if (!flush(i)) return null;
      i++;
      if (c === "\n") endSeg();
    } else if (c === "(" || c === ")" || c === "`") {
      return null;
    } else if (c === "#" && !w) {
      while (i < cmd.length && cmd.charAt(i) !== "\n") i++;
    } else if (c === ";" || c === "|" || (c === "&" && n !== ">")) {
      if (!flush(i)) return null;
      endSeg();
      i++;
    } else if (c === "<" || c === ">" || c === "&") {
      const fd = w as ScanWord | null;
      const start = fd && fd.digits && c !== "&" ? fd.start : i;
      if (start !== i) w = null;
      else if (!flush(i)) return null;
      const j = operatorEnd(cmd, i);
      if (cmd.charAt(j) === "(" || (c === "<" && n === "<")) return null; // process substitution, heredoc, here-string: not modelled
      seg.redirs.push({ start, end: j });
      target = true;
      i = j;
    } else if (c === "'") {
      const e = cmd.indexOf("'", i + 1);
      if (e < 0) return null;
      add(cmd.slice(i + 1, e));
      i = e + 1;
    } else if (c === '"') {
      let j = i + 1;
      let dyn = false;
      let text = "";
      for (; j < cmd.length && cmd.charAt(j) !== '"'; j++) {
        const d = cmd.charAt(j);
        if (d === "`" || (d === "$" && cmd.charAt(j + 1) === "(")) return null;
        if (d === "\\" && "$`\"\\".includes(cmd.charAt(j + 1))) { j++; text += cmd.charAt(j); continue; }
        if (d === "$" && EXPANDS.test(cmd.charAt(j + 1))) dyn = true;
        text += d;
      }
      if (j >= cmd.length) return null;
      add(text, dyn);
      i = j + 1;
    } else if (c === "\\") {
      if (n === "" || n === "\n") return null;
      add(n);
      i += 2;
    } else if (c === "$") {
      if (n === "'" || n === '"' || n === "(") return null;
      add(c, EXPANDS.test(n));
      i++;
    } else {
      add(c, GLOBBY.test(c) || (c === "~" && !w), true);
      i++;
    }
  }
  if (!flush(cmd.length)) return null;
  endSeg();
  return segs;
}

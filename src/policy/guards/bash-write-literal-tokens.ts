/** One shell word: its text after quote removal. Only fully literal words survive tokenizing. */
export interface Word {
  kind: "word";
  text: string;
  quoted: boolean;
}
/** A redirect / here-doc operator, or `sep` for `;` / `&&`. */
export interface Op {
  kind: "op" | "sep";
  text: string;
}
/** One token of a purely literal command line. */
export type Token = Word | Op;

/** Unquoted characters that mean expansion, grouping, globbing or a construct this classifier does not model. */
const UNMODELED = /[$`\\(){}*?[\]~!#]/;

/** Read a quoted segment starting at `i` (the quote char); returns [text, closing index] or null when unterminated or expanding. */
function quotedSegment(line: string, i: number): [string, number] | null {
  const quote = line[i] ?? "";
  const end = line.indexOf(quote, i + 1);
  if (end === -1) return null;
  const text = line.slice(i + 1, end);
  if (quote === '"' && /[$`\\]/.test(text)) return null;
  return [text, end];
}

/**
 * Tokenize one physical line into literal words, redirect operators and
 * separators. Fd duplications (`2>&1`, `>&-`) are dropped (no file involved).
 * @param line - One line of the command (no newline).
 * @returns The tokens, or null as soon as anything is not plainly literal (expansion, pipe, `&`, `N>file`, `<file`, grouping, glob, unterminated quote).
 */
export function tokenize(line: string): Token[] | null {
  const out: Token[] = [];
  let word: string | null = null;
  let quoted = false;
  const flush = (): void => {
    if (word !== null) out.push({ kind: "word", text: word, quoted });
    word = null;
    quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (ch === " " || ch === "\t") { flush(); continue; }
    if (ch === "'" || ch === '"') {
      const seg = quotedSegment(line, i);
      if (seg === null) return null;
      word = (word ?? "") + seg[0];
      quoted = true;
      i = seg[1];
      continue;
    }
    if (ch === ";") { flush(); out.push({ kind: "sep", text: ";" }); continue; }
    if (ch === "&" && line[i + 1] === "&") { flush(); out.push({ kind: "sep", text: "&&" }); i++; continue; }
    if (ch === "&" && line[i + 1] === ">") {
      flush();
      const op = line[i + 2] === ">" ? "&>>" : "&>";
      out.push({ kind: "op", text: op });
      i += op.length - 1;
      continue;
    }
    if (ch === ">") {
      const fd = !quoted && word !== null && /^\d+$/.test(word);
      const dup = /^&(?:\d+|-)/.exec(line.slice(i + 1));
      if (dup) {
        if (fd) word = null;
        flush();
        i += dup[0].length;
        continue;
      }
      if (fd) return null;
      flush();
      const op = line[i + 1] === ">" ? ">>" : line[i + 1] === "|" ? ">|" : ">";
      out.push({ kind: "op", text: op });
      i += op.length - 1;
      continue;
    }
    if (ch === "<") {
      flush();
      const op = ["<<<", "<<-", "<<"].find((candidate) => line.startsWith(candidate, i));
      if (op === undefined) return null;
      out.push({ kind: "op", text: op });
      i += op.length - 1;
      continue;
    }
    if (ch === "|" || ch === "&" || UNMODELED.test(ch)) return null;
    word = (word ?? "") + ch;
  }
  flush();
  return out;
}

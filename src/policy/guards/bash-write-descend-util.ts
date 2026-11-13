/** Index of the `)` closing a substitution whose body starts at `i` (right after the `(`), or `s.length`. */
export function closeParen(s: string, i: number): number {
  let depth = 1;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "'") { const e = s.indexOf("'", j + 1); if (e < 0) return s.length; j = e; continue; }
    if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return s.length;
}

/** Index of the closing backtick (skipping `\``), or `s.length`. */
export function closeBacktick(s: string, i: number): number {
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "`") return j;
  }
  return s.length;
}

/**
 * Reads one here-document starting at `pos` (the first char after the newline that follows the
 * operator line) up to its terminator line.
 * @returns The body, the raw text through the terminator line (no trailing newline) and the index after it.
 */
export function readHeredoc(src: string, pos: number, delim: string, strip: boolean): { body: string; raw: string; next: number } {
  let p = pos;
  let body = "";
  while (p < src.length) {
    let eol = src.indexOf("\n", p);
    if (eol < 0) eol = src.length;
    const line = src.slice(p, eol).replace(/\r$/, "");
    if ((strip ? line.replace(/^\t+/, "") : line) === delim) { p = eol + 1; break; }
    body += `${src.slice(p, eol)}\n`;
    p = eol + 1;
  }
  const next = Math.min(p, src.length);
  return { body, raw: src.slice(pos, next).replace(/\n$/, ""), next };
}

/**
 * @module motion/program-bodies
 * Locates single-quoted awk/gawk/mawk program bodies that a quote
 * opens AND closes within the same source, so the sensitive-data scan can
 * strip shell field references (`$3`, `${2}`) strictly inside them. Quoting
 * follows POSIX shell rules: a single quote is never escaped; a double quote
 * is escaped by an odd backslash run. An unclosed quote yields no span, so
 * whatever follows stays fully scanned.
 */

/** Shell command whose quoted operand is a program: awk/gawk/mawk (group 1), or sh/bash with `-c` (possibly clustered, e.g. `-ec`); the command word must be followed by whitespace (`awk-free` is prose). */
const PROGRAM_LINE_RE = /(?:^|[;|&]\s*)\s*(g?awk|mawk)(?=\s)/g;

/** Heredoc opener (`<<EOF`, `<<-'EOF'`, `<< "EOF"`); group 1 is the terminator word. */
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?/y;

/**
 * True when offset `end` of `text`, scanned from `from`, is NOT plain shell
 * command position: inside a `'`/`"` string (possibly opened on an earlier
 * line), a `#` comment (POSIX §2.3) or a heredoc body (§2.7.4). Any doubt
 * counts as text: the program word is ignored and nothing is stripped.
 */
function notCommandPosition(text: string, from: number, end: number): boolean {
  let quote: string | null = null;
  for (let k = from; k < end; k++) {
    const ch = text[k];
    if (quote !== null) {
      if (ch === quote && (quote === "'" || text[k - 1] !== "\\")) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (k === 0 || /\s/.test(text[k - 1] ?? ""))) {
      const nl = text.indexOf("\n", k);
      if (nl === -1 || nl >= end) return true;
      k = nl;
      continue;
    }
    if (ch !== "<" || text[k + 1] !== "<") continue;
    HEREDOC_RE.lastIndex = k;
    const h = HEREDOC_RE.exec(text);
    const bodyStart = text.indexOf("\n", k);
    if (h === null || bodyStart === -1 || bodyStart >= end) continue;
    const t = new RegExp(`^\\t*${h[1]}$`, "m").exec(text.slice(bodyStart + 1));
    const bodyEnd = t === null ? text.length : bodyStart + 1 + t.index + t[0].length;
    if (bodyEnd >= end) return true;
    k = bodyEnd - 1;
  }
  return quote !== null;
}

/** Field/positional references (`$3`, `${12}`) — or an awk `"…"` string literal, matched first so a `$5` inside a string (`print "Only $5"`) stays text for the amount scan. A following digit/period/comma keeps `$40`, `$1,299.00` intact. */
const FIELD_REF_RE = /"(?:[^"\\\n]|\\.)*"|#[^\n]*|(?<=^|\n)[ \t]*[-*•+][ \t][^\n]*|(?<=(?:[({[,=<>!+\-*/%&|;:?~]|\b(?:print|printf|return|in)\b)\s*)(?:\$\{\d+\}|\$\d(?![\d.,]))/g;

/** Half-open `[start, end)` offsets of a quoted program body. */
export type BodySpan = readonly [number, number];

/** Offset of the closing quote for the quote at `open`, or -1 when the quote never closes. The first matching quote ends the body (POSIX §2.2.2); if a letter or digit follows it, it is prose (`c'est`) or a concatenated word (`'{print}'file`), so the body is treated as unclosed and nothing is stripped — a body never extends past that quote. */
function closeQuoteAt(text: string, open: number): number {
  const quote = text[open];
  for (let p = open + 1; p < text.length; p++) {
    if (text[p] !== quote) continue;
    if (quote !== "'") {
      let backslashes = 0;
      for (let j = p - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 1) continue;
    }
    const next = text[p + 1];
    if (next !== undefined && /[A-Za-z0-9]/.test(next)) return -1;
    return p;
  }
  return -1;
}

/**
 * Closed program-body spans of `text`, in order. Only a quote opened after a
 * program command on the same line qualifies; a quote that never closes ends
 * the scan without a span (nothing after it can be proven outside a string,
 * so nothing there is stripped). Spans already closed stay valid.
 */
export function programBodySpans(text: string): BodySpan[] {
  const spans: BodySpan[] = [];
  let lineStart = 0;
  let from = 0;
  let scanFrom = 0;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    PROGRAM_LINE_RE.lastIndex = from;
    const m = PROGRAM_LINE_RE.exec(line);
    if (m === null) {
      lineStart = lineEnd + 1;
      from = 0;
      continue;
    }
    let openRel = -1;
    for (let k = m.index + m[0].length; k < line.length; k++) {
      const ch = line[k];
      // A pipe/list operator before the quote means the quote belongs to another command (`| awk | 'note`).
      if (ch === "|" || ch === ";" || ch === "&") break;
      // Only a single-quoted program qualifies: in `"…"` the shell expands `$5`, so it is never a plain awk field.
      if (ch === "'") openRel = k;
      if (ch === "'" || ch === '"') break;
    }
    if (openRel === -1 || notCommandPosition(text, scanFrom, lineStart + m.index)) {
      lineStart = lineEnd + 1;
      from = 0;
      continue;
    }
    const open = lineStart + openRel;
    const close = closeQuoteAt(text, open);
    if (close === -1) return spans;
    // An awk program has a `{ action }`; a body without one is prose (`; awk 'est … ' etc`), never stripped.
    if (text.slice(open + 1, close).includes("{")) spans.push([open + 1, close]);
    scanFrom = close + 1;
    lineStart = text.lastIndexOf("\n", close - 1) + 1;
    from = close - lineStart + 1;
  }
  return spans;
}

/** `text` with field references replaced by `x` inside each closed program body — a letter, never the empty string, so stripped neighbors can never fuse into a currency match (`€${2}5` becomes `€x5`, not `€5`). */
export function stripProgramBodies(text: string): string {
  const spans = programBodySpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const [start, end] of spans) {
    out += text.slice(last, start) + text.slice(start, end).replace(FIELD_REF_RE, (ref) => (ref.startsWith("$") ? "x" : ref));
    last = end;
  }
  return out + text.slice(last);
}

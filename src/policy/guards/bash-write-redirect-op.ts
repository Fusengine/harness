import type { ShellRedirect } from "./bash-write-redirects";

/** Read one shell word starting at `start`: strips quotes/escapes, stops at whitespace or `; & | < >`. */
function readTarget(input: string, start: number, end: number): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = start; i < end; i++) {
    const ch = input[i] ?? "";
    if (ch === "\\" && quote !== "'") {
      if (i + 1 < end) out += input[++i] ?? "";
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s|[;&|<>]/.test(ch)) break;
    out += ch;
  }
  return out;
}

/** `>&word` where word is plain digits or `-` duplicates/closes a descriptor (no file is written).
 * `2-` (bash fd-move) is deliberately NOT here: zsh treats `>&2-` as a file named `2-`. */
const FD_DUP = /^(?:\d+|-)$/;

/** Result of parsing the `>` at one position: the redirect found (if any) and the last operator index. */
export type ParsedRedirect = Readonly<{ redirect: ShellRedirect | null; opEnd: number }>;

/**
 * Parse the output-redirect operator whose `>` sits at `input[i]`. Handles the
 * plain forms (`>`, `>>`, `>|`, `N>`, `N>>`) and the ampersand forms the legacy
 * scanner skipped: `&>`, `&>>`, `>&word`, `>>&word`, `N>&word` (non-numeric
 * word), `&&>` (a plain `>` after `&&`). Descriptor duplication (`>&2`, `2>&1`,
 * `>&-`) and `&>&` stay non-redirects. Redirects the legacy scanner never
 * reported carry `extended: true`, so the legacy list can be reproduced exactly.
 * @param input - Full command text.
 * @param i - Index of the `>` character (not followed by `(`).
 * @param start - Start of the current scan range (bounds backward lookups).
 * @param end - End of the current scan range.
 */
export function parseOutputRedirect(input: string, i: number, start: number, end: number): ParsedRedirect {
  const none: ParsedRedirect = { redirect: null, opEnd: i };
  let run = 0;
  while (i - 1 - run >= start && input[i - 1 - run] === "&") run++;
  const ampBefore = run % 2 === 1; // `&>`; an even run is `&&` followed by a plain `>`
  let opStart = i;
  if (ampBefore) opStart = i - 1;
  else if (run === 0) {
    while (opStart > start && /\d/.test(input[opStart - 1] ?? "")) opStart--;
    if (opStart < i && input[opStart - 1] === "&") opStart--;
  }
  let cursor = i + 1;
  if (input[cursor] === ">" || input[cursor] === "|") cursor++;
  const opEnd = cursor - 1;
  const glued = input[cursor] === "&";
  const afterOp = cursor;
  while (/\s/.test(input[cursor] ?? "")) cursor++;
  if (input[cursor] === "&") {
    if (ampBefore || !glued) return none; // `&>&2`, `> &2`: unchanged skip
    cursor++;
    const ampEnd = cursor - 1;
    // Only a plain `>&` / `N>&` can duplicate; `>>&`, `>|&`, `>&|`, `>&!` open the named file (zsh).
    let canDup = afterOp === i + 1;
    if (input[cursor] === "|" || input[cursor] === "!") { cursor++; canDup = false; }
    while (/\s/.test(input[cursor] ?? "")) cursor++;
    const target = readTarget(input, cursor, end);
    if (!target || (canDup && FD_DUP.test(target))) return none;
    return { redirect: { start: opStart, operator: input.slice(opStart, ampEnd + 1), target, extended: true }, opEnd: ampEnd };
  }
  const target = readTarget(input, cursor, end);
  if (!target) return none;
  const extended = run > 0 || undefined;
  const operator = input.slice(opStart, afterOp);
  return { redirect: extended ? { start: opStart, operator, target, extended } : { start: opStart, operator, target }, opEnd };
}

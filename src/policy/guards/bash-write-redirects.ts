import { parseOutputRedirect } from "./bash-write-redirect-op";

/** One active shell output-redirection operator and its parsed target. `extended` marks the
 * ampersand forms (`&>`, `>&word`, `&&>`...) the legacy scanner skipped; only
 * {@link shellFileWriteRedirects} returns them. */
export type ShellRedirect = Readonly<{ start: number; operator: string; target: string; extended?: true }>;

function closingParen(input: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")" && --depth === 0) return i;
  }
  return input.length;
}

function closingBacktick(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === "`") return i;
  }
  return input.length;
}

function closingArithmetic(input: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch !== ")") continue;
    if (depth === 1 && input[i + 1] === ")") return i + 1;
    depth--;
  }
  return input.length;
}

function closingConditional(input: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length - 1; i++) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "]" && input[i + 1] === "]") return i;
  }
  return input.length;
}

function commentStart(input: string, index: number, start: number): boolean {
  return input[index] === "#" && (index === start || /[\s;|&()]/.test(input[index - 1] ?? ""));
}

function commandPosition(input: string, index: number, start: number): boolean {
  const prefix = input.slice(start, index);
  const segment = prefix.slice(Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("|"), prefix.lastIndexOf("&"), prefix.lastIndexOf("\n")) + 1).trim();
  return segment === "" || /^(?:if|elif|while|until|then|do|!)$/.test(segment);
}

function scanDoubleQuote(input: string, start: number, end: number, out: ShellRedirect[]): number {
  for (let i = start; i < end; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === '"') return i;
    if (input[i] === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const close = closingArithmetic(input, i + 3);
      scanExpansions(input, i + 3, close - 1, out);
      i = close;
    } else if (input[i] === "$" && input[i + 1] === "(") {
      const close = closingParen(input, i + 2);
      scanRange(input, i + 2, close, out);
      i = close;
    } else if (input[i] === "`") {
      const close = closingBacktick(input, i + 1);
      scanRange(input, i + 1, close, out);
      i = close;
    }
  }
  return end;
}

function scanExpansions(input: string, start: number, end: number, out: ShellRedirect[]): void {
  for (let i = start; i < end; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (commentStart(input, i, start)) {
      const newline = input.indexOf("\n", i + 1);
      i = newline < 0 || newline >= end ? end : newline;
      continue;
    }
    if (input[i] === "'") {
      const close = input.indexOf("'", i + 1);
      i = close < 0 || close >= end ? end : close;
      continue;
    }
    if (input[i] === '"') { i = scanDoubleQuote(input, i + 1, end, out); continue; }
    if (input[i] === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const close = closingArithmetic(input, i + 3);
      scanExpansions(input, i + 3, close - 1, out);
      i = close;
    } else if (input[i] === "$" && input[i + 1] === "(") {
      const close = closingParen(input, i + 2);
      scanRange(input, i + 2, close, out);
      i = close;
    } else if (input[i] === "`") {
      const close = closingBacktick(input, i + 1);
      scanRange(input, i + 1, close, out);
      i = close;
    }
  }
}

function scanRange(input: string, start: number, end: number, out: ShellRedirect[]): void {
  for (let i = start; i < end; i++) {
    const ch = input[i];
    if (ch === "\\") { i++; continue; }
    if (commentStart(input, i, start)) {
      const newline = input.indexOf("\n", i + 1);
      i = newline < 0 || newline >= end ? end : newline;
      continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      i = close < 0 || close >= end ? end : close;
      continue;
    }
    if (ch === '"') { i = scanDoubleQuote(input, i + 1, end, out); continue; }
    if (ch === "[" && input[i + 1] === "[" && commandPosition(input, i, start)) {
      const close = closingConditional(input, i + 2);
      scanExpansions(input, i + 2, close, out);
      i = close + 1;
      continue;
    }
    if (ch === "(" && input[i + 1] === "(" && commandPosition(input, i, start)) {
      const close = closingArithmetic(input, i + 2);
      scanExpansions(input, i + 2, close - 1, out);
      i = close;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const close = closingArithmetic(input, i + 3);
      scanExpansions(input, i + 3, close - 1, out);
      i = close;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") {
      const close = closingParen(input, i + 2);
      scanRange(input, i + 2, close, out);
      i = close;
      continue;
    }
    if (ch === "`") {
      const close = closingBacktick(input, i + 1);
      scanRange(input, i + 1, close, out);
      i = close;
      continue;
    }
    if (ch !== ">" || input[i + 1] === "(") continue;
    const { redirect, opEnd } = parseOutputRedirect(input, i, start, end);
    if (!redirect) continue;
    out.push(redirect);
    if (redirect.extended) i = opEnd;
  }
}

/** Return the legacy `>`-family output redirects (no `&>` / `>&word` / `&&>` forms; quoted/escaped
 * `>` characters excluded). Consumers outside the bash-write guard keep this view unchanged. */
export function shellOutputRedirects(command: string): ShellRedirect[] {
  return shellFileWriteRedirects(command).filter((redirect) => !redirect.extended);
}

/** Every redirect that writes a file: the legacy list plus the ampersand forms (`&>`, `&>>`, `>&file`,
 * `>>&file`, `N>&file`, `&&>`). Descriptor duplication (`>&2`, `2>&1`, `>&-`) is never included. */
export function shellFileWriteRedirects(command: string): ShellRedirect[] {
  const out: ShellRedirect[] = [];
  scanRange(command, 0, command.length, out);
  return out;
}

import type { Prompt } from "../../prompt/types";
import { NO_CWD, cwdAfterCd, isOrdinaryFileTarget, type Cwd } from "./bash-write-literal-target";
import { tokenize, type Token } from "./bash-write-literal-tokens";
import { READERS, UNSAFE_ARGS } from "./bash-write-scratchpad-words";

/** One literal file write found in a command. */
export interface LiteralWrite {
  target: string;
  append: boolean;
}

/** One simple command with its literal redirects and input source. */
interface Statement {
  words: string[];
  files: LiteralWrite[];
  hereString: boolean;
  heredoc: { delimiter: string; quoted: boolean; strip: boolean } | null;
}

/** Parse the tokens of one simple command; null on an operator without its operand. */
function parseStatement(tokens: readonly Token[]): Statement | null {
  const st: Statement = { words: [], files: [], hereString: false, heredoc: null };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.kind === "word") { st.words.push(tok.text); continue; }
    const operand = tokens[i + 1];
    if (operand?.kind !== "word") return null;
    i++;
    if (tok.text === "<<<") st.hereString = true;
    else if (tok.text.startsWith("<<")) st.heredoc = { delimiter: operand.text, quoted: operand.quoted, strip: tok.text === "<<-" };
    else if (operand.text === "") return null;
    else st.files.push({ target: operand.text, append: tok.text.endsWith(">>") });
  }
  return st;
}

/** Split a line's tokens at separators and parse each non-empty group. */
function parseLine(tokens: readonly Token[]): Statement[] | null {
  const out: Statement[] = [];
  let group: Token[] = [];
  for (const tok of [...tokens, { kind: "sep", text: "" } as Token]) {
    if (tok.kind !== "sep") { group.push(tok); continue; }
    if (group.length > 0) {
      const st = parseStatement(group);
      if (st === null) return null;
      out.push(st);
    }
    group = [];
  }
  return out;
}

/** Index of the delimiter line closing the here-document that starts after line `at`; `at` when none; null when unterminated or expanding. */
function consumeHeredoc(lines: readonly string[], at: number, st: Statement): number | null {
  const doc = st.heredoc;
  if (doc === null) return at;
  const body: string[] = [];
  for (let n = at + 1; n < lines.length; n++) {
    const line = doc.strip ? (lines[n] ?? "").replace(/^\t+/, "") : (lines[n] ?? "");
    if (line === doc.delimiter) return !doc.quoted && /[$`\\]/.test(body.join("\n")) ? null : n;
    body.push(lines[n] ?? "");
  }
  return null;
}

/** Writes performed by one statement, [] for a harmless reader; null when it is neither. */
function writesOf(st: Statement): LiteralWrite[] | null {
  const [name, ...args] = st.words;
  const files = st.files.filter((f) => f.target !== "/dev/null");
  const input = st.hereString || st.heredoc !== null;
  if (name === undefined || st.files.length > 1) return null;
  // A device (`/dev/stderr`, `/dev/tty`, `/dev/tcp/...`) is not a file the Write tool can create: keep the old verdict.
  if (st.files.some((f) => f.target.startsWith("/dev/") && f.target !== "/dev/null")) return null;
  if (name === "printf" && (args[0]?.startsWith("-") || args.some((a) => a.includes("%(")))) return null;
  if (name === "echo" || name === "printf") return input ? null : files;
  if (name === "cat" && files.length === 1) return input && args.length === 0 ? files : null;
  if (name === "tee") {
    const append = args[0] === "-a";
    const targets = append ? args.slice(1) : args;
    const ok = st.files.length === 0 && input && targets.length > 0 && targets.every((t) => t !== "" && !t.startsWith("-") && !t.startsWith("/dev/"));
    return ok ? targets.map((target) => ({ target, append })) : null;
  }
  const unsafe = UNSAFE_ARGS[name];
  const reads = files.length === 0 && !input && READERS.has(name) && !(unsafe && args.some((a) => unsafe.test(a)));
  return reads ? [] : null;
}

/**
 * Find the file writes of a command whose content is fully literal: `echo` /
 * `printf` redirected, or `cat` / `tee` fed by a here-document (expansion-free)
 * or here-string, chained only with `;` / `&&` and read-only commands. Any
 * variable, substitution, backtick, glob, pipe, background job or unknown
 * command makes the whole command unclassified (null) so the caller keeps its
 * verdict.
 * @param cmd - Full raw command.
 * @returns The literal writes (at least one), or null when the command is not purely literal.
 */
export function literalWrites(cmd: string, payloadCwd?: string): LiteralWrite[] | null {
  const lines = cmd.split("\n");
  const writes: LiteralWrite[] = [];
  let cwd: Cwd = NO_CWD;
  for (let n = 0; n < lines.length; n++) {
    const tokens = tokenize(lines[n] ?? "");
    const statements = tokens === null ? null : parseLine(tokens);
    if (statements === null) return null;
    for (const st of statements) {
      const found = writesOf(st);
      if (found === null) return null;
      if (st.words[0] === "cd") cwd = st.words.length === 2 ? cwdAfterCd(st.words[1]) : { kind: "unknown" };
      // Only provably ordinary files (fresh name / regular file in a real dir): anything else keeps the old verdict.
      if (!found.every((w) => isOrdinaryFileTarget(w.target, cwd, payloadCwd))) return null;
      writes.push(...found);
      const next = consumeHeredoc(lines, n, st);
      if (next === null) return null;
      n = next;
    }
  }
  return writes.length > 0 ? writes : null;
}

/**
 * Block verdict for a Bash write of literal text to a non-code file: the
 * model must use the Write tool (create/overwrite) or Edit (append/change).
 * @param cmd - Full raw command.
 * @returns A block prompt, or null when the command is not purely literal text.
 */
export function literalWriteBlock(cmd: string, payloadCwd?: string): Prompt | null {
  const writes = literalWrites(cmd, payloadCwd);
  if (writes === null) return null;
  const names = [...new Set(writes.map((w) => w.target))].join(", ");
  const how = writes.every((w) => w.append)
    ? `use the Edit tool to append to/change ${names} (or the Write tool if it does not exist yet)`
    : `use the Write tool to create/overwrite ${names}, or the Edit tool to append/change it`;
  return {
    kind: "block",
    title: "Bash write of literal text",
    reason: `Bash file write of literal text — ${how}`,
    actions: ["Use the Write/Edit tool instead"],
  };
}

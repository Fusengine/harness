/** One simple command of the line, with the separators that surround it. */
export interface Statement {
  /** Raw text between separators. */
  text: string;
  /** Offset of `text` in the command. */
  start: number;
  /** Separator before it: "" (first), ";", "&&", "||", "|" or "\n". */
  before: string;
  /** Separator after it: "" (last) or the same set. */
  after: string;
  /** "assign" (`S=...` only), "reader" (cannot write by itself), "runner" (test/build tool: runs arbitrary code), "empty" (no word, e.g. after a trailing `;`). */
  kind: "assign" | "reader" | "runner" | "empty";
  /** Command words after redirect removal. */
  words: string[];
  /** Number of redirects to a real file (not `/dev/null`, not an fd dup). */
  files: number;
}

/** Commands that cannot create, link or write files by themselves; their output goes only through shell redirects. */
export const READERS: ReadonlySet<string> = new Set(["cd", "pwd", "echo", "true", "false", "cat", "head", "tail", "wc", "ls", "grep", "sort", "tr", "cut", "basename", "dirname", "which", "stat", "du", "df"]);
/** Arguments that make an otherwise read-only command write a file or run a program. */
export const UNSAFE_ARGS:Readonly<Record<string, RegExp>> = { sort: /^(?:-[A-Za-z0-9]*[oST]|--)/ };
/** Test/lint/build runners already allowed without a redirect (SAFE_PREFIXES); they run arbitrary code, so no redirect may follow them. */
const RUNNERS: ReadonlyArray<readonly string[]> = [["bun", "test"], ["bun", "run"], ["bunx"], ["npx"], ["npm", "test"], ["npm", "run"], ["tsc"], ["biome"], ["eslint"], ["prettier"], ["ruff"], ["pyright"]];
/** Fd dup first (`2>&1`), then `N>`, `N>>`, `&>`, `&>>`, `>&file` with their target word. */
export const REDIRECT: RegExp = /\d*>&(?:\d+|-)|(?:&|\d*)>>?&?[ \t]*[^\s;&|<>)]+/g;
const DUP_ONLY = /^\d*>&(?:\d+|-)$/;
/** A word made only of characters the shell never expands or splits. */
export const PLAIN_WORD: RegExp = /^[A-Za-z0-9_./:=,+%@-]+$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** True when `words` starts with one of the RUNNERS prefixes. */
function isRunner(words: readonly string[]): boolean {
  return RUNNERS.some((r) => r.every((w, i) => words[i] === w));
}

/** Classify one statement's words (redirects already removed); null when it is none of the accepted kinds. */
function classify(words: string[]): Statement["kind"] | null {
  let at = 0;
  while (at < words.length && ASSIGN.test(words[at] ?? "")) at++;
  const rest = words.slice(at);
  if (rest.length === 0) return at === 0 ? "empty" : words.every((w) => w.startsWith("S=")) ? "assign" : null;
  // Plain words only: quotes, escapes, braces, globs, `(`, `~`, `!` can hide separators or option spellings from this naive parser.
  if (words.some((w) => !PLAIN_WORD.test(w.replace(/\$\{S\}|\$S(?![A-Za-z0-9_])/g, "S")))) return null;
  const head = rest[0] ?? "";
  if (head === "timeout" && /^\d+[smhd]?$/.test(rest[1] ?? "")) return isRunner(rest.slice(2)) ? "runner" : null;
  if (isRunner(rest)) return "runner";
  const unsafe = UNSAFE_ARGS[head];
  if (at === 0 && READERS.has(head) && !(unsafe && rest.slice(1).some((a) => unsafe.test(a)))) return "reader";
  return null;
}

/**
 * Split a command line into statements and classify each one. Splitting is
 * deliberately naive about quotes (a separator inside quotes only yields an
 * unclassifiable fragment, i.e. an extra ask, never a hidden command).
 * @param cmd - Full raw command.
 * @returns The statements, or null when any statement is not a plain assignment, reader or runner.
 */
export function parseStatements(cmd: string): Statement[] | null {
  const out: Statement[] = [];
  let from = 0;
  let before = "";
  for (const sep of [...cmd.matchAll(/&&|\|\||[;|\n]/g), null]) {
    const end = sep?.index ?? cmd.length;
    const text = cmd.slice(from, end);
    const redirects = text.match(REDIRECT) ?? [];
    const words = text.replace(REDIRECT, " ").split(/[ \t]+/).filter(Boolean);
    const kind = classify(words);
    if (kind === null) return null;
    const files = redirects.filter((r) => !/^(?:&|\d*)>>?&?[ \t]*["']?\/dev\/null/.test(r) && !DUP_ONLY.test(r)).length;
    out.push({ text, start: from, before, after: sep?.[0] ?? "", kind, words, files });
    from = end + (sep?.[0].length ?? 0);
    before = sep?.[0] ?? "";
  }
  return out;
}

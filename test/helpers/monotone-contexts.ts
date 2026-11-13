/**
 * Shell contexts for the Bash-write monotonicity law. `EXEC_CONTEXTS` keep the wrapped command
 * executing (the atom still writes); `NEUTRAL_CONTEXTS` turn it into data / dead code (nothing is
 * written) and are used to measure over-blocking. `compose` nests contexts to any depth.
 */
import type { Atom } from "./monotone-atoms";

/** A context: `wrap(cmd, n)` returns the wrapped command; `n` makes heredoc delimiters unique per depth. */
export interface Context {
  id: string;
  wrap: (cmd: string, n: number) => string;
  /** Neutral contexts only: single-line commands only (a trailing comment cannot swallow a heredoc). */
  singleLineOnly?: boolean;
}

/** POSIX single-quote a string. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** `head C; tail` for one-line commands, newline layout when the command spans lines. */
function block(head: string, tail: string): (cmd: string) => string {
  return (cmd) => (cmd.includes("\n") ? `${head}\n${cmd}\n${tail}` : `${head} ${cmd}; ${tail}`);
}

/** Contexts in which the wrapped command still executes. */
export const EXEC_CONTEXTS: readonly Context[] = [
  { id: "sh-c", wrap: (c) => `sh -c ${shQuote(c)}` },
  { id: "bash-c", wrap: (c) => `bash -c ${shQuote(c)}` },
  { id: "echo-pipe-sh", wrap: (c) => `echo ${shQuote(c)} | sh` },
  { id: "xargs-sh-c", wrap: (c) => `echo go | xargs -I@ sh -c ${shQuote(c)}` },
  { id: "eval", wrap: (c) => `eval ${shQuote(c)}` },
  { id: "timeout-sh-c", wrap: (c) => `timeout 5 sh -c ${shQuote(c)}` },
  { id: "env-sh-c", wrap: (c) => `env A=1 sh -c ${shQuote(c)}` },
  { id: "brace", wrap: block("{", "}") },
  { id: "if-true", wrap: block("if true; then", "fi") },
  { id: "for", wrap: block("for i in 1; do", "done") },
  { id: "while", wrap: (c) => (c.includes("\n") ? `while true; do\n${c}\nbreak; done` : `while true; do ${c}; break; done`) },
  { id: "case", wrap: (c) => (c.includes("\n") ? `case x in x)\n${c}\n;; esac` : `case x in x) ${c};; esac`) },
  { id: "function", wrap: (c) => (c.includes("\n") ? `f() {\n${c}\n}; f` : `f() { ${c}; }; f`) },
  { id: "subshell", wrap: block("(", ")") },
  { id: "and-list", wrap: (c) => `true && ${c.includes("\n") ? `{\n${c}\n}` : c}` },
  { id: "cmd-subst", wrap: (c) => `echo $(\n${c}\n)` },
  { id: "sh-heredoc", wrap: (c, n) => `sh <<'CTX${n}'\n${c}\nCTX${n}` },
  { id: "bash-s-heredoc", wrap: (c, n) => `bash -s <<'CTX${n}'\n${c}\nCTX${n}` },
  { id: "bash-procsub", wrap: (c) => `bash <(echo ${shQuote(c)})` },
  {
    id: "backslash-newline",
    wrap: (c) => {
      const i = c.indexOf(" ");
      return i < 0 ? c : `${c.slice(0, i)} \\\n${c.slice(i + 1)}`;
    },
  },
];

/** Execution contexts that only restructure the command line (no string handed to another shell): the scope of the cp/mv rule. */
export const COMPOUND_IDS: ReadonlySet<string> = new Set([
  "brace", "if-true", "for", "while", "case", "function", "subshell", "and-list", "backslash-newline",
]);

/** Contexts in which the wrapped command never writes anything (data, comment, dead branch). */
export const NEUTRAL_CONTEXTS: readonly Context[] = [
  { id: "echo-quoted", wrap: (c) => `echo ${shQuote(c)}` },
  { id: "printf-quoted", wrap: (c) => `printf %s ${shQuote(c)}` },
  { id: "git-commit-msg", wrap: (c) => `git commit -m ${shQuote(c)}` },
  { id: "rg-pattern", wrap: (c) => `rg ${shQuote(c)} src` },
  { id: "grep-pattern", wrap: (c) => `grep -F ${shQuote(c)} s.txt` },
  { id: "comment", singleLineOnly: true, wrap: (c) => `echo ok # ${c}` },
  { id: "heredoc-cat", wrap: (c, n) => `cat <<'NEU${n}'\n${c}\nNEU${n}` },
  { id: "false-and", wrap: (c) => `false && { ${c.includes("\n") ? `\n${c}\n` : `${c};`} }` },
  { id: "true-or", wrap: (c) => `true || { ${c.includes("\n") ? `\n${c}\n` : `${c};`} }` },
  { id: "if-false", wrap: block("if false; then", "fi") },
  { id: "while-false", wrap: block("while false; do", "done") },
  { id: "for-empty", wrap: block("for i in; do", "done") },
  { id: "case-nomatch", wrap: (c) => (c.includes("\n") ? `case x in y)\n${c}\n;; esac` : `case x in y) ${c};; esac`) },
  { id: "function-uncalled", wrap: (c) => (c.includes("\n") ? `f() {\n${c}\n}` : `f() { ${c}; }`) },
  { id: "sh-c-exit-first", wrap: (c) => `sh -c ${shQuote(`exit 0\n${c}`)}` },
];

/** Applies `chain` right-to-left: `chain[0]` is the outermost context. */
export function compose(atom: Atom, chain: readonly Context[]): string {
  let cmd = atom.cmd;
  for (let i = chain.length - 1; i >= 0; i--) {
    const ctx = chain[i];
    if (!ctx) continue;
    cmd = ctx.wrap(cmd, i + 1);
  }
  return cmd;
}

/** True when a neutral context cannot wrap this command (comment vs multi-line). */
export function inapplicable(ctx: Context, cmd: string): boolean {
  return ctx.singleLineOnly === true && cmd.includes("\n");
}

/** One generated case. */
export interface Case {
  atom: Atom;
  chain: readonly Context[];
  cmd: string;
  /** `exec`: atom still executes; `neutral`: it does not. */
  kind: "exec" | "neutral";
}

/**
 * Chains the host bash cannot run (so they are not "execution-preserving"): `<( )` is not available
 * inside `sh -c`-style children, and bash 3.2 (macOS) mis-parses a `case` pattern's `)` inside `$( )`.
 */
export function unrunnable(chain: readonly Context[]): boolean {
  const ids = chain.map((c) => c.id);
  return ids.slice(1).includes("bash-procsub") || ids.join(">") === "cmd-subst>case";
}

/** Every exec chain of the given depth (depth 1 and 2 are exhaustive, minus {@link unrunnable} ones). */
export function execCases(atoms: readonly Atom[], depth: 1 | 2): Case[] {
  const out: Case[] = [];
  for (const atom of atoms) {
    for (const a of EXEC_CONTEXTS) {
      if (depth === 1) out.push({ atom, chain: [a], cmd: compose(atom, [a]), kind: "exec" });
      else {
        for (const b of EXEC_CONTEXTS) {
          if (!unrunnable([a, b])) out.push({ atom, chain: [a, b], cmd: compose(atom, [a, b]), kind: "exec" });
        }
      }
    }
  }
  return out;
}

/** Neutral cases: neutral alone (depth 1), plus neutral under an exec wrapper and exec under neutral (depth 2). */
export function neutralCases(atoms: readonly Atom[]): Case[] {
  const out: Case[] = [];
  for (const atom of atoms) {
    for (const n of NEUTRAL_CONTEXTS) {
      if (inapplicable(n, atom.cmd)) continue;
      out.push({ atom, chain: [n], cmd: compose(atom, [n]), kind: "neutral" });
      for (const e of EXEC_CONTEXTS) {
        out.push({ atom, chain: [e, n], cmd: compose(atom, [e, n]), kind: "neutral" });
        const inner = compose(atom, [e]);
        if (!inapplicable(n, inner)) out.push({ atom, chain: [n, e], cmd: compose(atom, [n, e]), kind: "neutral" });
      }
    }
  }
  return out;
}

/** Stable label of a case. */
export function label(c: Case): string {
  return `${c.chain.map((x) => x.id).join(">")}(${c.atom.id})`;
}

/**
 * @module command-peel
 * Shared shell-command peeling: strip wrappers / env prefixes / git and gh
 * global options in front of the real verb, and split `git` and `gh`
 * invocations. Used by the release classifier and by the wrapper-aware
 * git / rm / gh policy (lexing lives in `shell-words`).
 */
import { basename } from "node:path";
import { ASSIGNMENT } from "./shell-words";

/** Verbs that run their argument as shell code. */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
/** Wrappers that append their own operands to the command they run (`echo ~ | xargs rm -rf x` also deletes `~`). */
export const APPENDING: ReadonlySet<string> = new Set(["xargs", "parallel"]);

/** How a wrapper's own words are laid out: options that take a value, and positional words before the command. */
interface WrapperSpec { value: ReadonlySet<string>; positional: number; positionalUnless?: string }
/** Build a {@link WrapperSpec}; `positionalUnless` is the option that replaces the positional words (`taskset -c`). */
const wrapper = (value: string[], positional = 0, positionalUnless?: string): WrapperSpec => ({ value: new Set(value), positional, positionalUnless });
/** Prefix commands and exactly the words each consumes; the NEXT word is the command they run (nothing is hunted past it). */
const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  ["nohup", wrapper([])], ["command", wrapper([])], ["builtin", wrapper([])], ["setsid", wrapper([])], ["busybox", wrapper([])], ["exec", wrapper(["-a"])],
  ["time", wrapper(["-f", "-o", "--format", "--output"])], ["nice", wrapper(["-n", "--adjustment"])], ["ionice", wrapper(["-c", "-n", "-p", "-P", "--class", "--classdata", "--ignore"])],
  ["stdbuf", wrapper(["-i", "-o", "-e", "--input", "--output", "--error"])], ["timeout", wrapper(["-s", "-k", "--signal", "--kill-after"], 1)],
  ["sudo", wrapper(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-D", "-R", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type"])], ["doas", wrapper(["-u", "-C"])],
  ["env", wrapper(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
  ["xargs", wrapper(["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a", "-R", "-S", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--arg-file", "--replace", "--eof"])],
  ["parallel", wrapper(["-j", "-n", "-N", "-S", "-a", "--jobs", "--max-args", "--sshlogin", "--arg-file"])], ["chrt", wrapper([], 1)], ["taskset", wrapper(["-c", "--cpu-list"], 1, "-c")],
  ["caffeinate", wrapper(["-t", "-w"])], ["flock", wrapper(["-w", "-E", "--timeout", "--conflict-exit-code"], 1)], ["script", wrapper(["-t"], 1)], ["watch", wrapper(["-n", "--interval"])],
]);
/** Words of `t` after one wrapper's options, assignments and positional words: the command it runs starts there. */
function afterWrapper(spec: WrapperSpec, t: string[]): string[] {
  let i = 0;
  let positional = spec.positional;
  for (; i < t.length; i++) {
    const a = t[i] ?? "";
    if (a === "--") { i++; break; }
    if (ASSIGNMENT.test(a)) continue;
    if (!a.startsWith("-") || a.length < 2) break;
    if (spec.positionalUnless && a === spec.positionalUnless) positional = 0;
    if (spec.value.has(a)) i++;
  }
  return t.slice(Math.min(i + positional, t.length));
}
/** git global options that consume the following token. */
const GIT_ARG_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
/** gh global options that consume the following token. */
const GH_ARG_OPTS = new Set(["-R", "--repo", "--hostname"]);

/** Drop quote and backslash characters inside a token (`g''h`, `\git`, `"tag"`). */
export const clean = (t: string): string => t.replace(/['"\\]/g, "");

/** Leading compound-command keywords / grouping openers stripped by {@link ungroup}. */
const LEAD = /^(?:[({!]\s+|\(|(?:if|then|do|else|elif|while|until)\s+)+/;
/** Occurrences of the character `ch` in `s`. */
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * A shell segment without its compound-command dressing: leading `(`, `{ `, `!`, `if`/`then`/`do`/`else`/
 * `while`…, a `case` label (`x) …`), a function header (`f() { …`) and unbalanced trailing `)` / `}`.
 * @param segment - One segment from `shellSegments`.
 */
export function ungroup(segment: string): string {
  let s = segment.trim();
  for (let guard = 0; guard < 8; guard++) {
    const before = s;
    s = s.replace(/^case\s.*?\sin\s+/, "").replace(/^[\w*|.-]+\)\s+/, "").replace(/^[\w-]+\s*\(\)\s*/, "").replace(LEAD, "").trim();
    let close = count(s, ")") - count(s, "(");
    while (close > 0 && s.endsWith(")")) { s = s.slice(0, -1).trimEnd(); close--; }
    close = count(s, "}") - count(s, "{");
    while (close > 0 && s.endsWith("}")) { s = s.slice(0, -1).trimEnd(); close--; }
    if (s === before) break;
  }
  return s;
}

/**
 * Strip wrappers in front of the real verb; returns the tokens from the verb on. Each wrapper consumes exactly
 * its own options, assignments and positional words (`timeout -s KILL 5`, `nice -n 5`, `sudo -u u`, `xargs -I @`);
 * the next word is the command it runs. A program that is not a wrapper (`./deploy.sh`, `node`, `make`…) ends
 * the peel: its arguments are never commands.
 * @param tokens - Tokens of one segment (env assignments already removed).
 */
export function peel(tokens: string[]): string[] {
  let t = tokens.map(clean);
  for (let guard = 0; guard < 16 && t.length > 0; guard++) {
    const spec = WRAPPERS.get(basename(t[0] ?? ""));
    if (!spec) break;
    t = afterWrapper(spec, t.slice(1));
  }
  return t;
}

/** Parsed `git` invocation: the subcommand, its arguments and the `-C` directories (in order). */
export interface GitParts { sub: string; args: string[]; dirs: string[] }

/**
 * Split peeled git tokens (`git`, global options, subcommand, args).
 * @param tokens - Peeled tokens, `git` first.
 */
export function gitParts(tokens: string[]): GitParts {
  const rest = tokens.slice(1);
  const dirs: string[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (GIT_ARG_OPTS.has(a)) {
      if (a === "-C" && rest[i + 1] !== undefined) dirs.push(rest[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    break;
  }
  return { sub: rest[i] ?? "", args: rest.slice(i + 1), dirs };
}

/**
 * Split peeled `gh` tokens: the first two words (`pr merge`; global `-R x` skipped) and the
 * arguments after them.
 * @param tokens - Peeled tokens, `gh` first.
 */
export function ghParts(tokens: string[]): { words: string[]; args: string[] } {
  const rest = tokens.slice(1);
  const words: string[] = [];
  let i = 0;
  for (; i < rest.length && words.length < 2; i++) {
    const a = rest[i] ?? "";
    if (GH_ARG_OPTS.has(a)) { i++; continue; }
    if (!a.startsWith("-")) words.push(a);
  }
  return { words, args: rest.slice(i) };
}

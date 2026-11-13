import type { Unit, WordTok } from "./bash-write-descend-types";

/** Words that only introduce a command (`then C`, `do C`, `{ C`): skipped to reach the real command. */
const LEADING = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "function", "coproc"]);
/** Compound-command heads/tails that run nothing themselves. */
const HEADS = new Set(["for", "case", "select", "esac", "fi", "done", "}", "in", "break", "continue"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Literal text of a word, or "" when the word is missing or dynamic (holds an expansion). */
const plain = (w: WordTok | undefined): string => (w && !w.dynamic ? w.value : "");
/** Last path segment of a word's literal text (`/usr/bin/cp` -> `cp`); "" when missing or dynamic. */
const base = (w: WordTok | undefined): string => plain(w).replace(/^.*\//, "");

/** Options of each transparent wrapper that consume the following word. */
const ARG_OPTS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "-S", "-C", "--unset", "--chdir", "--split-string"]),
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  xargs: new Set(["-I", "-n", "-P", "-d", "-L", "-E", "-s", "-a", "-J", "--max-args", "--max-procs", "--delimiter", "--arg-file"]),
  exec: new Set(["-a"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
};
const TRANSPARENT = new Set(["env", "nohup", "command", "exec", "builtin", "setsid", "nice", "sudo", "timeout", "stdbuf", "ionice", "xargs"]);

/** Index of the first argv word of `u` that is not a leading keyword (`if`, `then`, `do`, `{` ...). */
export function leading(u: Unit): number {
  let k = 0;
  while (k < u.argv.length && LEADING.has(plain(u.argv[k]))) k++;
  return k;
}

/**
 * Argv of the command that really runs: leading keywords, env assignments and transparent wrappers
 * (`env`, `timeout 5`, `nohup`, `xargs -I@`, `sudo -u x` ...) removed. Empty for compound heads/tails.
 * @param argv - Words of one command.
 */
export function peel(argv: readonly WordTok[]): WordTok[] {
  const a = [...argv];
  for (let guard = 0; guard < 16 && a.length > 0; guard++) {
    const v = plain(a[0]);
    if (v === "time") { a.shift(); while (a.length > 0 && plain(a[0]).startsWith("-")) a.shift(); continue; }
    if (v === "function") { a.splice(0, 2); continue; }
    if (LEADING.has(v)) { a.shift(); continue; }
    if (HEADS.has(v)) return [];
    if (ASSIGN.test(a[0]?.raw ?? "")) { a.shift(); continue; }
    const name = base(a[0]);
    if (!TRANSPARENT.has(name)) break;
    if (name === "command" && /^-[vV]/.test(plain(a[1]))) return [];
    a.shift();
    const takes = ARG_OPTS[name] ?? new Set<string>();
    while (a.length > 0) {
      const w = plain(a[0]);
      if (name === "env" && (ASSIGN.test(a[0]?.raw ?? ""))) { a.shift(); continue; }
      if (!w.startsWith("-") || w === "-") break;
      a.shift();
      if (takes.has(w) && a.length > 0) a.shift();
    }
    if (name === "timeout" && a.length > 0) a.shift();
    if (name === "nice" && /^\d+$/.test(plain(a[0]))) a.shift();
  }
  return a;
}

/** One command run by `find … -exec|-execdir|-ok|-okdir CMD ;|+`. */
export interface FindExec {
  argv: WordTok[];
  /** `-execdir` / `-okdir`: the child runs inside each match's directory (relative paths are not the cwd's). */
  inMatchDir: boolean;
  /** The find start paths (`{}` stands for files under them); `.` when none were given. */
  starts: WordTok[];
}

/** Commands run through `find … -exec|-execdir|-ok|-okdir CMD ;|+`. */
export function findExecs(argv: readonly WordTok[]): FindExec[] {
  if (base(argv[0]) !== "find") return [];
  const starts: WordTok[] = [];
  for (let k = 1; k < argv.length && !/^[-(!]/.test(plain(argv[k]) || "x"); k++) starts.push(argv[k] as WordTok);
  const out: FindExec[] = [];
  for (let k = 1; k < argv.length; k++) {
    const flag = plain(argv[k]);
    if (!/^-(exec|execdir|ok|okdir)$/.test(flag)) continue;
    let e = k + 1;
    while (e < argv.length && plain(argv[e]) !== ";" && plain(argv[e]) !== "+") e++;
    out.push({ argv: argv.slice(k + 1, e) as WordTok[], inMatchDir: flag.endsWith("dir"), starts });
    k = e;
  }
  return out;
}

export { base, plain };

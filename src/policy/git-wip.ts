/**
 * @module git-wip
 * Silent `git add` / `git commit` on a feature branch. The automatic commit flow
 * (WIP commits, owner decision "ca doit etre auto") must not stall on a
 * confirmation nobody can click, so a plain add/commit that provably runs on a
 * non-protected branch is not asked about. Everything else keeps its verdict.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PROTECTED_BRANCHES } from "./branch-name";
import { expand } from "./effective-segments";

/** Git options that redirect the command to another repository, worktree or config, plus `GIT_*` environment prefixes: the branch of `cwd` is then not the branch acted on. */
const REDIRECTED = /(?:^|\s)(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s|=|$)|\bGIT_[A-Z_]+=/;
/** A `git` word followed directly by an option: any global option (`--exec-path`, `--config-env`, `--bare`, `-p`…) changes the program, config or repository the subcommand uses. Matched after quotes and backslashes are dropped, so `"git"` or `g\it` cannot hide it. */
const GLOBAL_OPTION = /(?:^|[\s/;&|(])git\s+-/;
/** `git commit` flags that rewrite history or skip hooks, as written or inside a bundled short-flag word. */
const COMMIT_LONG = new Set(["--amend", "--no-verify", "--no-post-rewrite"]);
const COMMIT_SHORT = new Set(["n"]);
/** `git add` flags that override `.gitignore` (a way to stage secrets). */
const ADD_LONG = new Set(["--force"]);
const ADD_SHORT = new Set(["f"]);

/** True when `word` names a risky long flag in full or as a prefix: git accepts any unique prefix (`--amen` = `--amend`). */
function isRiskyLong(word: string, long: ReadonlySet<string>): boolean {
  const name = word.split("=")[0] ?? word;
  return name.length > 2 && name.startsWith("--") && [...long].some((flag) => flag.startsWith(name));
}

/** True when an option word of `argv` is one of the risky long flags (or a prefix of one) or carries one of the risky short letters. */
function hasRisky(argv: readonly string[], long: ReadonlySet<string>, short: ReadonlySet<string>): boolean {
  return argv.some((a) => isRiskyLong(a, long) || (/^-[A-Za-z]+$/.test(a) && [...a.slice(1)].some((c) => short.has(c))));
}

/** Shell expansion characters: brace, parameter/command substitution, glob, tilde. */
const DYNAMIC = /[{}$*?[~`]/;
/** Options of the read-only commands that write a file (`--output`) or run configured programs (`--ext-diff`, `--textconv`), as any unique prefix. */
const READ_ONLY_RISKY = /^--(?:o|ext|text)/;
/** Read-only git commands that may sit next to an add/commit in one line. Allowlist: any other subcommand (`switch`, `update-ref`, `branch -f`, `config`, `fetch +ref`…) keeps asking. */
const READ_ONLY = new Set(["status", "diff", "log", "show"]);

/** True when this git command is a plain `add` / `commit` (no risky flag) or a read-only command, and runs as the literal `git` word (no `env`, `timeout`, path or quote wrapper that could change directory). */
function isPlainOrQuiet(sub: string, argv: readonly string[], seg: string): boolean {
  if (!/^git\s/.test(seg.trimStart())) return false;
  // A word the shell still rewrites (`--{amend,quiet}`, `${Y:---amend}`, `$Y`, `*`, `~`) may become a risky flag: only plain words are judged. No exemption for quoted words: `--{amend,"q x"}` expands to `--amend`.
  if (argv.some((a) => DYNAMIC.test(a))) return false;
  if (READ_ONLY.has(sub)) return !argv.some((a) => READ_ONLY_RISKY.test(a));
  if (sub === "commit") return !hasRisky(argv, COMMIT_LONG, COMMIT_SHORT);
  if (sub === "add") return !hasRisky(argv, ADD_LONG, ADD_SHORT);
  return false;
}

/** Environment for the branch lookup: the caller's, without `GIT_*` variables that would point git elsewhere. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

/** Current branch of the repository holding `cwd`, or "" (detached HEAD, not a repository, git failure). */
function currentBranch(cwd: string): string {
  try {
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "branch", "--show-current"], { cwd, env: cleanEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * True when `command` is made only of git commands that are a plain `add` /
 * `commit` or a read-only `status`/`diff`/`log`/`show` (allowlist), each run as
 * the literal `git` word, and the branch checked out in `cwd` is known and not
 * protected. False on anything else (non-git word, `cd`, wrapper, substitution,
 * `--amend`, `--no-verify`, `add -f` or any unique prefix of them, a global
 * option such as `-C` / `--exec-path` / `--config-env`, `GIT_*`, opaque line,
 * detached HEAD, unusable cwd), so the caller keeps asking.
 * @param command - Raw Bash command.
 * @param cwd - Absolute directory the shell starts in (host payload cwd).
 */
export function isUnprotectedWip(command: string, cwd: string | undefined): boolean {
  if (cwd === undefined || !isAbsolute(cwd) || !existsSync(cwd) || REDIRECTED.test(command)) return false;
  if (GLOBAL_OPTION.test(command.replace(/["'\\]/g, ""))) return false;
  const { items, opaque } = expand(command);
  if (opaque || items.length === 0) return false;
  if (!items.every((i) => i.verb === "git" && !i.appends && isPlainOrQuiet(i.argv[0] ?? "", i.argv.slice(1), i.seg))) return false;
  const branch = currentBranch(cwd);
  return branch !== "" && !PROTECTED_BRANCHES.has(branch);
}

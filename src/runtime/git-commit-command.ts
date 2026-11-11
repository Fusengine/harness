import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gitSubcommand } from "../policy/release-command";
import { stripDataHeredocs } from "../policy/release-heredoc";
import { commandTokens, literalShellPayload, shellSegments } from "../policy/motion/shell-verbs";

const MAX_DEPTH = 4;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Drop subshell/group punctuation glued to a segment (`(git commit)`, `{ git commit; }`). */
function unwrap(segment: string): string {
  return segment.trim().replace(/^[({\s]+/, "").replace(/[)}\s]+$/, "");
}

/** `cd <literal>` target resolved against `dir`, or `dir` when not statically known. */
function afterCd(segment: string, dir: string): string {
  const target = commandTokens(segment)[1];
  if (!target || /[$`~*?]/.test(target) || target.startsWith("-")) return dir;
  const next = resolve(dir, target);
  return existsSync(next) && statSync(next).isDirectory() ? next : dir;
}

/** `-c alias.<sub>=commit…` (or `!…commit…`) in the git global options: the subcommand really runs a commit. */
function aliasesCommit(tokens: string[], sub: string): boolean {
  const head = `alias.${sub}=`;
  // Tokens keep their quotes (`alias.ci='commit` `-a'`): drop them, the value then starts right after `=`.
  return tokens.some((t, i) => {
    const bare = t.replace(/['"]/g, "");
    return tokens[i - 1] === "-c" && bare.startsWith(head) && /^!?(git\s+)?commit(\s|$)/.test(bare.slice(head.length));
  });
}

/** Literal `--work-tree <p>` / `--work-tree=<p>` global option: the working tree the commit lands in. */
function workTreeOf(tokens: string[]): string | null {
  for (const [i, t] of tokens.entries()) {
    if (t === "commit") return null;
    if (t.startsWith("--work-tree=")) return t.slice("--work-tree=".length) || null;
    if (t === "--work-tree") return tokens[i + 1] ?? null;
  }
  return null;
}

function scan(command: string, startDir: string, depth: number): string | null {
  let dir = startDir;
  for (const raw of shellSegments(command)) {
    const segment = unwrap(raw);
    const git = gitSubcommand(segment);
    if (git) {
      const tokens = commandTokens(segment);
      if (git.sub !== "commit" && !aliasesCommit(tokens, git.sub)) continue;
      let where = dir;
      for (const c of git.dirs) where = resolve(where, c);
      const wt = workTreeOf(tokens);
      if (wt && !/[$`~*?]/.test(wt)) where = resolve(where, wt);
      return existsSync(where) ? where : dir;
    }
    const verb = basename(commandTokens(segment)[0] ?? "");
    if (verb === "cd") dir = afterCd(segment, dir);
    else if (SHELLS.has(verb) && depth < MAX_DEPTH) {
      const inner = literalShellPayload(segment);
      const found = inner ? scan(inner, dir, depth + 1) : null;
      if (found) return found;
    }
  }
  return null;
}

/**
 * Directory in which `command` runs a `git commit`, or `null` when it does not.
 * Sees through `cd x &&`, git global options (`-C x`), env prefixes, wrappers,
 * subshells/groups and literal `sh -c` payloads; text inside quotes (`echo "git
 * commit"`) is never a commit. A non-literal `cd` target keeps the previous dir.
 * @param command - Raw Bash command.
 * @param cwd - Session working directory.
 */
export function gitCommitDir(command: string, cwd: string): string | null {
  // Heredoc bodies are data (a doc that mentions `git commit`), never commands.
  // A backslash-newline is a line continuation: the shell joins `git \<nl>commit` into `git commit`.
  return scan(stripDataHeredocs(command).replace(/\\\r?\n/g, ""), cwd, 0);
}

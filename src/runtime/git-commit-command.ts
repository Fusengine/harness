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

function scan(command: string, startDir: string, depth: number): string | null {
  let dir = startDir;
  for (const raw of shellSegments(command)) {
    const segment = unwrap(raw);
    const git = gitSubcommand(segment);
    if (git) {
      if (git.sub !== "commit") continue;
      let where = dir;
      for (const c of git.dirs) where = resolve(where, c);
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
  return scan(stripDataHeredocs(command), cwd, 0);
}

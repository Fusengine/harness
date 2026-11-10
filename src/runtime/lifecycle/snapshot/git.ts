import { execSync } from "node:child_process";
import { parseEnvInt } from "../../../config/env";

/** Env var overriding the per-git-call timeout (ms); tests pin it so a loaded runner cannot drop the section. */
export const GIT_TIMEOUT_ENV = "FUSE_SNAPSHOT_GIT_TIMEOUT_MS";
/** Default per-git-call timeout: the SessionStart hook must stay snappy, a slow git omits the section. */
const DEFAULT_GIT_TIMEOUT_MS = 150;

/**
 * Run a git subcommand at `root` with a short timeout, returning trimmed stdout.
 * Uses `node:child_process` (the Bun shell can hang on some git plumbing) and
 * swallows every failure — a non-repo, missing git, or timeout yields `""` so
 * the caller omits the section instead of throwing inside the hook.
 * @param root - Directory to run git in.
 * @param args - The git args (e.g. `"log --oneline -3"`).
 * @returns Trimmed stdout, or `""` on any error.
 */
function git(root: string, args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      encoding: "utf8",
      timeout: parseEnvInt(process.env[GIT_TIMEOUT_ENV], DEFAULT_GIT_TIMEOUT_MS),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Working-tree file counts parsed from `git status --porcelain`. */
interface Wip {
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Count staged/unstaged/untracked files from porcelain v1 output (skips the `##` branch line). */
function countWip(porcelain: string): Wip {
  const w: Wip = { staged: 0, unstaged: 0, untracked: 0 };
  for (const line of porcelain.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("??")) { w.untracked++; continue; }
    const x = line[0], y = line[1];
    if (x && x !== " " && x !== "?") w.staged++;
    if (y === "M" || y === "D") w.unstaged++;
  }
  return w;
}

/** Parse the current branch from the leading `## branch...upstream` porcelain line. */
function parseBranch(porcelain: string): string {
  const head = porcelain.split("\n")[0] ?? "";
  if (!head.startsWith("## ")) return "";
  const rest = head.slice(3);
  const dots = rest.indexOf("...");
  return (dots >= 0 ? rest.slice(0, dots) : rest).split(" ")[0] ?? "";
}

/**
 * Collect a compact git reconciliation section for `root`: current branch, the
 * last three commits (oneline), and staged/unstaged/untracked WIP counts. When
 * `root` is not a git repo (status fails) the whole section is omitted (`""`).
 * @param root - The project/repo root.
 * @returns The rendered git section body, or `""` when not a repo.
 */
export function collectGit(root: string): string {
  const status = git(root, "status --porcelain=v1 --branch");
  if (!status) return "";
  const branch = parseBranch(status) || "(unknown)";
  const w = countWip(status);
  const log = git(root, "log --oneline -3");
  const lines = [`- branch: ${branch}`];
  if (log) lines.push("- recent:", ...log.split("\n").map((l) => `    ${l}`));
  lines.push(`- WIP: ${w.staged} staged, ${w.unstaged} unstaged, ${w.untracked} untracked`);
  return lines.join("\n");
}

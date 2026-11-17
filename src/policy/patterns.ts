/**
 * Guard pattern data, ported verbatim from the fusengine git/install guards.
 * Note (faithful): `--force` also matches `--force-with-lease` — preserved
 * from the source guard, now as an explicit alternation instead of an
 * accidental substring match (see {@link GIT_BLOCKED}).
 */
import { expand } from "./effective-segments";

/**
 * Token-boundary suffix for a destructive flag: only whitespace, `=`, or
 * end-of-string may follow — never another word character. Without this, a
 * flag regex matches as a plain substring of any argument (a branch/file name
 * like `fix/guard-false-positives` contains `-f`, `feature-force-refactor`
 * contains `-force`), turning a rename into a false-positive hard block
 * (proven live: `git push -u origin fix/api-keys-fossil` denied as
 * "Destructive git command"). No leading-boundary group is needed on the flag
 * side — every pattern below prefixes the flag with a literal `\s`, and the
 * flag can never be the first character of the whole command since a git
 * verb (`git push`, `git reset`, ...) always precedes it.
 */
const FLAG_END = "(?:\\s|=|$)";
/** `-f` / `--force` / `--force-with-lease`, boundary-anchored on both flag forms. */
const FORCE_FLAG = `\\s(?:--force(?:-with-lease)?|-f)${FLAG_END}`;
/**
 * `git clean` short-flag cluster containing both `f` and `d` in any order
 * (`-fd`, `-df`, `-fdx`, `-fdX`, `-xfd`…): a MORE destructive superset than a
 * bare `-fd` — must stay blocked, never downgrade to `git clean`'s GIT_ASK.
 */
const CLEAN_FD_FLAG = `\\s-(?=[a-zA-Z]*f)(?=[a-zA-Z]*d)[a-zA-Z]+${FLAG_END}`;

/** Destructive git operations to block outright. */
export const GIT_BLOCKED: ReadonlyArray<RegExp> = [
  new RegExp(`git push.*${FORCE_FLAG}`),
  new RegExp(`git reset.*\\s--hard${FLAG_END}`),
  new RegExp(`git clean.*${CLEAN_FD_FLAG}`),
  new RegExp(`git branch.*\\s-D${FLAG_END}`),
  new RegExp(`git rebase.*${FORCE_FLAG}`),
];

/** Git operations that warrant a confirmation prompt. */
export const GIT_ASK: ReadonlyArray<RegExp> = [
  /git push/, /git checkout/, /git reset/, /git rebase/, /git merge/,
  /git stash/, /git clean/, /git rm/, /git mv/, /git restore/,
  /git revert/, /git cherry-pick/, /git commit/, /git add/, /git branch -d/,
  // Pointing core.hooksPath elsewhere turns every later (now silent) commit into a hook-skipping one, like --no-verify.
  // Same segment, whole `git` word: `cat .git/config | grep core.hooksPath` or `echo digit core.hooksPath` are not git config.
  /\bgit\b[^;&|\n]*core\.hookspath/i,
];

/** System-level package installs (need confirmation). */
export const SYSTEM_INSTALL: ReadonlyArray<RegExp> = [
  /brew install/, /brew upgrade/, /brew cask/, /apt install/, /apt-get install/,
  /dnf install/, /pacman -S/,
];

/** Project-level package installs. */
export const PROJECT_INSTALL: ReadonlyArray<RegExp> = [
  /npm install/, /npm i /, /yarn add/, /pnpm add/, /pip install/, /pip3 install/,
  /composer require/, /bun add/, /bun install/, /cargo install/, /go install/,
  /gem install/, /pipx install/,
];

/** True when `cmd` matches any pattern in `patterns`. */
export function matchPatterns(cmd: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((re) => re.test(cmd));
}

/**
 * True when `cmd` matches a git pattern, either as written or as a command it
 * really runs behind a wrapper (`git -C x push -f`, `sh -c 'git reset --hard'`,
 * `cd x && git push -f`…): the patterns are also matched against each git
 * command found by {@link expand} in canonical form. Never weaker than
 * {@link matchPatterns}.
 */
export function matchGitPatterns(cmd: string, patterns: ReadonlyArray<RegExp>): boolean {
  if (matchPatterns(cmd, patterns)) return true;
  if (patterns === GIT_ASK && removesBranchOrWorktree(cmd)) return true;
  return expand(cmd).items.some((item) => item.verb === "git" && matchPatterns(item.text, patterns));
}

/** Flags of `gh pr merge` that consume the next token (their value is never a strategy or delete flag). */
export const GH_MERGE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit", "-R", "--repo"]);

/** `git branch` arguments that delete: `-d`, `-D`, `--delete`, or a bundle of plain short flags holding one (`-fd`, `-df`). */
function branchDeletes(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--delete") return true;
    if (/^-[dDfrqavi]*[dD][dDfrqavi]*$/.test(a)) return true;
  }
  return false;
}

/** `gh pr merge` arguments that delete the branch (`--delete-branch`, `-d`, `-md`; values of {@link GH_MERGE_VALUE_FLAGS} skipped). */
function mergeDeletesBranch(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (GH_MERGE_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a === "--delete-branch" || a === "--delete-branch=true") return true;
    if (/^-[dmsr]+$/.test(a) && a.includes("d")) return true;
  }
  return false;
}

/**
 * True when a command the line really runs (wrappers and shell payloads
 * descended) deletes a branch or a worktree: `git branch -d|-D|--delete`,
 * `git worktree remove`, `gh pr merge --delete-branch|-d`. Only ever adds a
 * confirmation: callers consult it after the destructive-git block gate.
 */
export function removesBranchOrWorktree(cmd: string): boolean {
  return expand(cmd).items.some((item) => {
    const [a = "", b = "", ...rest] = item.argv;
    if (item.verb === "git") return (a === "branch" && branchDeletes([b, ...rest])) || (a === "worktree" && (b === "remove" || b === "rm"));
    return item.verb === "gh" && a === "pr" && b === "merge" && mergeDeletesBranch(rest);
  });
}

/** Git commands exempt from confirmation when Ralph mode is on (parity git-guard.py RALPH_SAFE). */
export const RALPH_SAFE: ReadonlyArray<string> = [
  "git add", "git commit", "git checkout -b", "git branch --show-current",
  "git status", "git diff", "git log",
];

/**
 * OPT-IN autonomous "Ralph" mode: OFF unless `RALPH_MODE` is `1`/`true`, read
 * fresh on each call. Only the env var activates it — the Python source also
 * auto-enabled on a `.claude/ralph/prd.json` file or a `feature/*` branch, but
 * those silent activations are dropped here: a mode that removes git/install
 * confirmations must never turn on implicitly (owner: default OFF, env opt-in).
 */
export function isRalphMode(): boolean {
  const v = process.env.RALPH_MODE;
  return v === "1" || v === "true";
}

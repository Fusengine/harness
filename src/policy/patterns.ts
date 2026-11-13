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
  return expand(cmd).items.some((item) => item.verb === "git" && matchPatterns(item.text, patterns));
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

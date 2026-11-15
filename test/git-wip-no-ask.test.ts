import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/policy/evaluate";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-wip-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Create a repo with one commit, checked out on `branch` (or detached when `detach`). */
function repo(name: string, branch: string, detach = false): string {
  const dir = join(root, name);
  const g = (...a: string[]): void => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" }); };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  g("commit", "-q", "--allow-empty", "-m", "init");
  if (branch !== "main") g("checkout", "-q", "-b", branch);
  if (detach) g("checkout", "-q", "--detach");
  return dir;
}
const feature = repo("feature", "fix/commit-agent-no-ask");
const main = repo("main", "main");
const master = repo("master", "master");
const develop = repo("develop", "develop");
const production = repo("production", "production");
const detached = repo("detached", "feat/x", true);

type Verdict = "allow" | "ask" | "block";
function v(command: string, cwd: string | undefined): Verdict {
  const r = evaluate({ tool: "Bash", command, cwd });
  return r.decision === "allow" ? "allow" : r.prompt?.kind === "block" ? "block" : "ask";
}

describe("git add / git commit on a non-protected branch are silent", () => {
  test.each([
    "git commit -F msg.txt",
    "git commit -m 'feat: x'",
    "git commit -am 'x'",
    "git commit -F /private/tmp/claude-501/p/sess/scratchpad/merge-wave2-msg.txt",
    "git add -A",
    "git add src/a.ts test/a.test.ts",
    "git add . && git commit -m 'x'",
    "git status && git add -A && git commit -F m.txt",
  ])("%s", (cmd) => {
    expect(v(cmd, feature)).toBe("allow");
  });
});

describe("negative control: protected branches keep asking", () => {
  for (const [name, dir] of [["main", main], ["master", master], ["develop", develop], ["production", production]] as const) {
    test(`${name}: commit and add still ask`, () => {
      expect(v("git commit -F msg.txt", dir)).toBe("ask");
      expect(v("git commit -m x", dir)).toBe("ask");
      expect(v("git add -A", dir)).toBe("ask");
    });
  }
});

describe("unknown branch or cwd keeps the old verdict", () => {
  test("detached HEAD, missing cwd, non-repo cwd, relative cwd", () => {
    expect(v("git commit -m x", detached)).toBe("ask");
    expect(v("git commit -m x", undefined)).toBe("ask");
    expect(v("git commit -m x", root)).toBe("ask");
    expect(v("git commit -m x", "relative/dir")).toBe("ask");
  });
});

describe("only plain add/commit are exempt", () => {
  test.each([
    "git commit --amend -m x",
    "git commit --amend --no-edit",
    "git commit --no-verify -m x",
    "git commit -n -m x",
    "git commit -an -m x",
    "git add -f .env",
    "git add --force .env",
    "git add -Af x",
    // Unique-prefix abbreviations git accepts for the risky long flags (gitcli "Abbreviating long options").
    "git commit --amen -m x",
    "git commit --am -m x",
    "git commit --no-ver -m x",
    "git commit --no-post -m x",
    "git add --forc .env",
    "git add --fo .env",
    // Any global option between `git` and the subcommand (other program, config, repository).
    "git --exec-path=/tmp/evil commit -m x",
    "git --exec-path /tmp/evil commit -m x",
    "git --config-env=core.hooksPath=HP commit -m x",
    "git --bare commit -m x",
    "git -p commit -m x",
    "git --no-pager add -A",
    "\"git\" --exec-path=/tmp/evil commit -m x",
    "/usr/bin/git --exec-path=/tmp/evil commit -m x",
    "git add -A && git --exec-path=/tmp/evil commit -m x",
    "git -C /tmp/elsewhere commit -m x",
    "git --git-dir=/x/.git commit -m x",
    "git --work-tree=/x commit -m x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "GIT_DIR=/x/.git git commit -m x",
    "cd ../main && git commit -m x",
    "git commit -m x && git push origin HEAD",
    "git commit -m x; git checkout main",
    "env --chdir=/some/other/repo git commit -am x",
    "timeout 5 git commit -m x",
    "nice git commit -m x",
    "/usr/bin/git commit -m x",
    "git commit -m x --{amend,quiet}",
    "git commit -m x --amend{,}",
    "git commit -m x ${Y:---amend}",
    "git commit -m x $Y",
    "git commit -m x \"$Y\"",
    "git commit -m x -{n,v}",
    "git add *",
    "git commit -m x --{amend,\"quiet x\"}",
    "git commit -m x --{amend,'q x'}",
    "git commit -m \"x\" --a{mend,\" b\"}",
    "git commit -m x -{n,\"v x\"}",
    "git add -{f,\" x\"} .",
    "git commit -m x && git diff --output=/tmp/x",
    "git commit -m x && git log --out=/tmp/x",
    "git commit -m x && git diff --ext-diff",
    "git log -p --textconv && git commit -m x",
    "git switch main && git commit -am x",
    "git symbolic-ref HEAD refs/heads/main && git commit -m x",
    "git commit -m x && git update-ref refs/heads/main HEAD~5",
    "git commit -m x && git update-ref -d refs/heads/main",
    "git commit -m x && git send-pack origin HEAD:main",
    "git commit -m x && git branch -f main HEAD",
    "git commit -m x && git branch -M main2 main",
    "git commit -m x && git fetch origin +main:main",
    "git commit -m x && git pull --rebase",
    "git commit -m x && git filter-branch -f HEAD",
    "git commit -m x && git reflog expire --expire=now --all",
    "git commit -m x && git gc --prune=now",
    "git config core.hooksPath /tmp/h && git commit -m x",
    "git worktree add ../x main && git commit -m x",
    "git add -A && git stash",
    "git commit -m \"$(git push origin main)\"",
    "sh -c 'git commit -m x && git merge other'",
    "git commit -m x | git reset HEAD~1",
    "git push origin HEAD",
    "git checkout main",
    "git merge other",
    "git stash",
    "git restore .",
    "git rm a.ts",
    "git revert HEAD",
    "git cherry-pick abc",
    "git branch -d x",
    "git rebase main",
    "git reset HEAD~1",
  ])("%s keeps asking or blocking", (cmd) => {
    expect(v(cmd, feature)).not.toBe("allow");
  });
});

describe("destructive git stays blocked on a feature branch", () => {
  test.each([
    "git push --force origin x",
    "git push -f",
    "git push --force-with-lease",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git branch -D old",
    "git rebase -f main",
    "git commit -m x && git push --force",
    "git commit -m x && git reset --hard",
  ])("%s", (cmd) => {
    expect(v(cmd, feature)).toBe("block");
  });
  test("push and reset (soft) still ask", () => {
    expect(v("git push origin HEAD", feature)).toBe("ask");
    expect(v("git reset HEAD~1", feature)).toBe("ask");
  });
});

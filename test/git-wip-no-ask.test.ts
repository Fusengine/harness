import { describe, expect, test } from "bun:test";
import { gitWipRepos, v } from "./helpers/git-wip-repos";

const { detached, develop, feature, main, master, production, root } = gitWipRepos();

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
    "git commit -F m.txt 2>&1",
    "git add -A 2>&1 && git commit -m x >/dev/null 2>&1",
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

describe("hooksPath changes always ask (a silent commit after them would skip hooks like --no-verify)", () => {
  test.each([
    "git config core.hooksPath /dev/null",
    "git config core.hooksPath /tmp/h && git commit -m x",
    "git config --local core.hooksPath /tmp/h",
    "git config --global core.hooksPath /tmp/h",
    "git config core.hookspath /tmp/h",
    "git config --add core.hooksPath /tmp/h",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git -c core.hooksPath=/dev/null status",
  ])("%s", (cmd) => {
    expect(v(cmd, feature)).toBe("ask");
    expect(v(cmd, main)).toBe("ask");
  });
  test("reading config stays silent", () => {
    expect(v("git config --get user.name", feature)).toBe("allow");
  });
  test("shell spellings of the key still ask", () => {
    for (const cmd of ["git config core.hooks\\Path /dev/null", "git config 'core.hooks''Path' x", "\"git\" config core.hooksPath x"]) expect(v(cmd, feature)).toBe("ask");
  });
  test("the key outside a git command does not ask", () => {
    for (const cmd of ["cat .git/config | grep core.hooksPath", "git status && grep core.hooksPath README.md", "echo digit core.hooksPath"]) expect(v(cmd, feature)).toBe("allow");
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

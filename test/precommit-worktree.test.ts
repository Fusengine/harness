import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preCommitGate } from "../src/runtime/precommit";
import { git, setupFixture, spy, teardownFixture, type PrecommitFixture } from "./helpers/precommit-fixture";

let fx: PrecommitFixture;
beforeAll(() => { fx = setupFixture(); });
afterAll(() => teardownFixture(fx));

test("fixture sanity: the same commit blocks in the main checkout and passes in the worktree", () => {
  const m = spy();
  expect(preCommitGate("Bash", "git commit -m y", fx.main, m.exec)?.kind).toBe("block");
  const w = spy();
  expect(preCommitGate("Bash", "git commit -m y", fx.wt, w.exec)).toBeNull();
});

test("the gate lints exactly the worktree the commit lands in (session cwd, subdir, cd, git -C, --work-tree)", () => {
  const { wt } = fx;
  for (const [cmd, cwd] of [["git commit -m y", wt], ["git commit -m y", join(wt, "src")], [`cd ${wt} && git commit -m y`, wt], [`git -C ${wt} commit -m y`, wt], [`git --work-tree=${wt} commit -m y`, wt], [`git --work-tree ${wt} commit -m y`, wt]] as const) {
    const s = spy();
    expect([cmd, preCommitGate("Bash", cmd, cwd, s.exec)]).toEqual([cmd, null]);
    expect([cmd, s.cwds.length > 0 && s.cwds.every((c) => c === wt)]).toEqual([cmd, true]);
  }
});

test("a commit aimed at another tree lints BOTH that tree and the session cwd (union: what main linted is never dropped)", () => {
  const { wt, main } = fx;
  for (const cmd of [`cd ${wt} && git commit -m y`, `git -C ${wt} commit -m y`, `git --work-tree=${wt} commit -m y`]) {
    const s = spy();
    expect([cmd, preCommitGate("Bash", cmd, main, s.exec)?.kind]).toEqual([cmd, "block"]); // main (no node_modules) fails, exactly as on main
    expect([cmd, s.cwds.includes(wt) && s.cwds.includes(main)]).toEqual([cmd, true]);
  }
});

test("never the main checkout: a worktree subdir without a manifest does not climb into the main tree", () => {
  const s = spy();
  rmSync(join(fx.wt, "package.json"), { force: true });
  try {
    expect(preCommitGate("Bash", "git commit -m y", join(fx.wt, "src"), s.exec)).toBeNull();
    expect(s.cwds).toEqual([]);
  } finally {
    git(fx.wt, fx.base, "checkout", "--", "package.json");
  }
});

test("a commit resolved to a tree with no manifest falls back to the session cwd (never silently unlinted)", () => {
  const bare = join(fx.base, "bare");
  mkdirSync(bare, { recursive: true });
  for (const c of [`git --work-tree=${bare} commit -m y`, `git -C ${bare} commit -m y`, `cd ${bare} && git commit -m y`]) {
    const s = spy();
    expect([c, preCommitGate("Bash", c, fx.main, s.exec)?.kind]).toEqual([c, "block"]);
    expect([c, s.cwds.length > 0 && s.cwds.every((d) => d === fx.main)]).toEqual([c, true]);
    const w = spy();
    expect([c, preCommitGate("Bash", c, fx.wt, w.exec)]).toEqual([c, null]);
    expect([c, w.cwds.every((d) => d === fx.wt)]).toEqual([c, true]);
  }
});

test("a resolved dir outside any repo never lets a stray ancestor manifest replace the session-cwd lint", () => {
  const anc = join(fx.base, "anc");
  mkdirSync(join(anc, "out"), { recursive: true });
  writeFileSync(join(anc, "package.json"), "{}"); // manifest-bearing ancestor, but `out` is in no repository
  for (const c of [`git --work-tree=${join(anc, "out")} commit -qam wip`, `git -C ${join(anc, "out")} commit -qam wip`]) {
    const s = spy();
    expect([c, preCommitGate("Bash", c, fx.main, s.exec)?.kind]).toEqual([c, "block"]);
    expect([c, s.cwds.every((d) => d === fx.main)]).toEqual([c, true]);
  }
});

test("a resolved dir whose manifest has nothing to lint still lints the session cwd (A1/A5 of challenger 9)", () => {
  const sub = join(fx.main, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "package.json"), "{}"); // manifest only: collect() runs nothing there
  for (const c of ["git -C sub commit -m x", "git -C sub -c alias.ci=commit ci", `git --work-tree=${sub} commit`]) {
    const s = spy();
    expect([c, preCommitGate("Bash", c, fx.main, s.exec)?.kind, s.cwds.includes(fx.main)]).toEqual([c, "block", true]);
  }
});

test("every real commit form stays gated (wrapper corpus)", () => {
  const forms = ["git commit -m y", "cd x && git commit -m y", "git -C x commit -m y", "FOO=1 git commit -m y", "sh -c 'git commit -m y'", "(git commit -m y)", "{ git commit -m y; }", "git add . && git commit -m y", "env GIT_X=1 git -c a=b commit -m y", "cd x; git commit -m y", "git commit --amend", "git -c user.name=a commit -m y"];
  for (const c of forms) {
    const s = spy();
    expect([c, preCommitGate("Bash", c, fx.main, s.exec)?.kind]).toEqual([c, "block"]);
  }
});

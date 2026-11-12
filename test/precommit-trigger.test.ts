import { test, expect, beforeAll, afterAll } from "bun:test";
import { preCommitGate } from "../src/runtime/precommit";
import { setupFixture, spy, teardownFixture, type PrecommitFixture } from "./helpers/precommit-fixture";

let fx: PrecommitFixture;
beforeAll(() => { fx = setupFixture(); });
afterAll(() => teardownFixture(fx));

const fires = (c: string, cwd: string): boolean => preCommitGate("Bash", c, cwd, spy().exec)?.kind === "block";

test("read-only git without the word commit, and quoted text, never fire the gate", () => {
  for (const c of ["git show --stat HEAD", 'echo "git commit"', "git status", "git diff --cached", "git log --oneline && git status", "ls && echo commit"]) {
    const s = spy();
    expect([c, preCommitGate("Bash", c, fx.main, s.exec), s.cwds]).toEqual([c, null, []]);
  }
});

// Property: main's trigger (`startsWith("git") && includes("commit")`) is a SUBSET of the new trigger, by construction. The read-only
// forms below mention "commit" and therefore STILL fire: a known, documented false trigger deferred to an owner decision (not a regression).
const legacyTrigger = (c: string): boolean => c.startsWith("git") && c.includes("commit");
const PROPERTY_CORPUS: string[] = [
  "git log -1 --format='%h commit-probe'", "git log --grep=commit", "git log --oneline --format=%s commit", "git commit-tree HEAD", "git push # commit", "git pull --no-rebase . commitx",
  "git commit -m y", "git commit --amend", "git -c user.name=a commit -m y", "git commit -am y", "git add . && git commit -m y", "git -C x commit -m y", "git status; git commit -m a",
  "git $'commit' -m a", "git log $(git commit -m a)", "git add . && eval git commit -m a", "git -c ALIAS.x=commit x", "git -c alias.x=commit x -m a", "git \\\ncommit -m b",
  "git add -A # it's fine\ngit commit -m msg", "git log \\<<true\ngit commit -qam wip\ntrue", "git --shallow-file log commit -qam pw", "git log -1 <(git commit -qam pw)",
  "git status; GIT_EDITOR={git,commit,-qF} git add -e", "git config core.editor 'git commit -qm x #' && git tag -a t1", "git push --exec='git commit -qm x' . HEAD:z",
  "git stash push -m commit", "git branch commit2", "git tag commit-t", "git worktree add ../wt-commit", "git checkout -b commitbr", "git show --grep=commit",
  "git status # don't\ngit commit -qam pw", "git log;(git log )#'\ngit commit -qam wip\n(true )#'", "git --attr-source log commit -qam pw", "git diff >(git commit -qam pw)",
  "git add . && fish -c 'git commit -m a'", "git add . && if true; then git commit; fi", "git add . && ! git commit -m a", "git ${X:-commit} -m a", "git -c core.editor='git commit -qm x' tag -a t1",
  "git fetch --upload-pack='git commit -qm x' . c", "git grep --open-files-in-pager='git commit -qm x #' y", "git -c protocol.ext.allow=always fetch 'ext::git commit -qm x'",
];

test("property: every command main's legacy trigger fires on still fires, in the main checkout and with a subdir cwd", () => {
  const triggered = PROPERTY_CORPUS.filter(legacyTrigger);
  expect(triggered.length).toBeGreaterThan(40);
  for (const c of triggered) expect([c, fires(c, fx.main)]).toEqual([c, true]);
});

test("known false trigger (documented, owner decision pending): read-only git mentioning commit still fires, lint aimed at the right tree", () => {
  for (const c of ["git log -1 --format='%h commit-probe'", "git log --grep=commit"]) {
    const w = spy();
    expect([c, preCommitGate("Bash", c, fx.wt, w.exec), w.cwds.every((d) => d === fx.wt)]).toEqual([c, null, true]);
    expect([c, fires(c, fx.main)]).toEqual([c, true]);
  }
});

test("inline alias, line continuation and shell comments that hide a real commit stay gated", () => {
  for (const c of ["git -c alias.x=commit x -m a", "git -c alias.ci='commit -a' ci", "git \\\ncommit -m b", "git -c alias.x='!git commit' x", "git add -A # stage it's fine\ngit commit -m msg"]) {
    expect([c, fires(c, fx.main)]).toEqual([c, true]);
  }
  expect(fires("git -c alias.x=status x", fx.main)).toBe(false);
});

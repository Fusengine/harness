/**
 * Owner git-flow rules as stateless gates: "merge, never squash" (rule 06) and
 * the `<type>/<kebab>` (< 50 chars) branch-naming rule, each also behind the
 * wrappers of the monotone law.
 */
import { describe, test, expect } from "bun:test";
import { evaluate } from "../src/policy/evaluate";
import { branchNameProblem, createdBranches } from "../src/policy/branch-name";
import { kind } from "./helpers/wrapper-law";

const WRAP = ["{C}", "git -C x {C}", "cd x && {C}", "sh -c '{C}'", "( {C} )", "FOO=1 {C}", "eval '{C}'", "echo '{C}' | sh"];
const wrapped = (w: string, c: string): string => (w.startsWith("git -C") ? c.replace("git ", "git -C x ") : w.replace("{C}", c));

describe("gh pr merge: merge, never squash", () => {
  test.each(["--squash", "-s", "--rebase", "-r", "-sd", "--squash --delete-branch", "--delete-branch -s", "-R o/r --squash"])("gh pr merge 5 %s -> block", (flags) => {
    expect(kind(`gh pr merge 5 ${flags}`)).toBe("block");
  });
  test.each(["--merge", "-m", "--merge --delete-branch", "-md", "--auto --merge", "-t 'fix: squash bug' --merge", "-b 'rebase notes' -m"])("gh pr merge 5 %s -> not blocked", (flags) => {
    expect(kind(`gh pr merge 5 ${flags}`)).not.toBe("block");
  });
  test("every wrapper keeps the block, and the block message names the rule", () => {
    for (const w of WRAP.filter((x) => !x.startsWith("git -C"))) expect(kind(wrapped(w, "gh pr merge 5 --squash"))).toBe("block");
    expect(evaluate({ tool: "Bash", command: "gh pr merge 5 -s" }).prompt?.reason).toContain("never squash");
  });
  test("prose and reads are untouched", () => {
    for (const c of ["echo 'gh pr merge --squash'", "gh pr view 5", "gh pr list --search squash", "git commit -m 'gh pr merge --squash'"]) expect(kind(c)).not.toBe("block");
  });
});

describe("branch names", () => {
  test.each(["fix/fail-open-paths", "feat/x", "chore/deps-2026", "docs/decisions-2026-11-10", "test/robust-heredoc-perf", "ci/a1-b2", "build/x", "style/x", "perf/x", "refactor/x"])("%s complies", (n) => {
    expect(branchNameProblem(n)).toBeNull();
  });
  test.each(["Feature", "fix", "fix/", "fix/Bad", "fix/a_b", "fix/a--b", "fix/-a", "feature/x", "main", "bruno/fix-x", "fix/a b", `fix/${"a".repeat(46)}`])("%j is rejected", (n) => {
    expect(branchNameProblem(n)).not.toBeNull();
  });
  test("length: 49 characters pass, 50 fail", () => {
    expect(branchNameProblem(`fix/${"a".repeat(45)}`)).toBeNull();
    expect(branchNameProblem(`fix/${"a".repeat(46)}`)).not.toBeNull();
  });
  test("non-literal names cannot be judged and pass", () => {
    for (const n of ["$BRANCH", "fix/$(date +%s)", "`x`", "fix/*"]) expect(branchNameProblem(n)).toBeNull();
  });
});

describe("branch creation forms", () => {
  test.each([
    [["checkout", "-b", "fix/x"], ["fix/x"]],
    [["checkout", "-B", "fix/x", "origin/fix/x"], ["fix/x"]],
    [["switch", "-c", "feat/y"], ["feat/y"]],
    [["switch", "--create=feat/y"], ["feat/y"]],
    [["branch", "feat/z"], ["feat/z"]],
    [["branch", "-f", "main", "origin/main"], []],
    [["branch", "-dr", "origin/old"], []],
    [["branch", "--sort", "committerdate"], []],
    [["branch", "--sort=-committerdate", "--format=%(refname)"], []],
    [["branch", "-M", "main"], []],
    [["branch", "-m", "master", "main"], []],
    [["branch", "-m", "old", "feat/new"], ["feat/new"]],
    [["branch", "-d", "x"], []],
    [["branch", "-D", "x"], []],
    [["branch", "-a"], []],
    [["branch", "--show-current"], []],
    [["branch", "--contains", "abc"], []],
    [["branch", "-u", "origin/x"], []],
    [["checkout", "main"], []],
    [["checkout", "--", "f"], []],
    [["switch", "main"], []],
  ] as const)("%j creates %j", (argv, names) => expect(createdBranches(argv)).toEqual([...names]));
});

describe("branch-name gate (all wrappers)", () => {
  const bad = ["git checkout -b BadName", "git switch -c feature/x", "git branch tmp", "git checkout -B fix/UPPER", `git checkout -b fix/${"a".repeat(50)}`];
  test.each(bad)("%s -> block", (c) => {
    for (const w of WRAP) expect(kind(wrapped(w, c))).toBe("block");
  });
  test("compliant creation is unchanged (checkout still asks, switch/branch allow)", () => {
    expect(kind("git checkout -b fix/ok-name")).toBe("ask");
    expect(kind("git switch -c feat/ok-name")).toBe("allow");
    expect(kind("git branch fix/ok-name")).toBe("allow");
    expect(kind("git -C x switch -c feat/ok-name")).toBe("allow");
  });
  test("lists, deletions, prose and dynamic names never block", () => {
    for (const c of ["git branch", "git branch -a", "git branch -vv", "git branch --show-current", "echo 'git checkout -b Bad'", "git checkout -b $BRANCH", "git switch -c \"$B\""]) expect(kind(c)).not.toBe("block");
  });
});

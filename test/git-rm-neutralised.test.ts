/**
 * Over-block measurement for the wrapper-aware git / rm / gh policy: commands
 * that only MENTION a destructive command (prose, greps, reads) must keep the
 * verdict they had before the change (frozen from a run on the unchanged
 * base), so descending into wrappers adds no false block or ask.
 */
import { describe, test, expect } from "bun:test";
import { kind } from "./helpers/wrapper-law";

/** Verdict on the base before the change (substring patterns already asked on these; the rest were allowed). */
const BASE_ASK = [
  'echo "git push -f"', 'echo "git push --force"', 'git log --grep "git reset --hard"', 'echo "git reset --hard"', 'echo "rm -rf ./x"', 'grep -rn "rm -rf" src',
  "git checkout -- file.ts", 'git commit -m "docs: explain rm -rf and git push -f"', 'git commit -m "squash merge notes"', "git checkout -b fix/ok-name",
  'echo "git checkout -b BadName"', "rm -rf node_modules", "rm ./a",
];
const BASE_ALLOW = [
  "git log --grep=reset", 'grep -n "rm" file.txt', "echo unlink", "cat docs/git-push-force.md", "ls git-push-force", "man git-reset", "git status", "git diff --stat",
  "git -C x status", "git -C x log --oneline", "git --no-pager log -5", "git branch --show-current", "git branch -a", "git branch -vv", "echo trash", "ls ~/.Trash",
  "mv x ~/.Trash/", "trash-put ./x", "cd x && ls", 'sh -c "echo hi"', 'bash -c "git status"', 'sh -c "git log -1"', 'echo "gh pr merge --squash"', "gh pr view 5",
  "gh pr list --search squash", "gh pr merge 5 --merge --delete-branch", "gh pr create --title squash --body rebase", "git switch -c feat/ok-name", "git branch fix/ok-name",
  "git log --format=%H -3", "echo go | xargs -I@ echo @", "(cd x && ls)", "{ ls; }", "for i in 1 2; do echo $i; done", "env FOO=1 ls", "time ls", 'find . -name "*.tmp"',
  "rm -rf ~/.Trash/old", "rm ~/.Trash/x", "echo done # trash",
];

describe("neutralised forms keep their old verdict", () => {
  test.each(BASE_ASK)("%s -> ask", (c) => expect(kind(c)).toBe("ask"));
  test.each(BASE_ALLOW)("%s -> allow", (c) => expect(kind(c)).toBe("allow"));
  test("the only intended flip in this set: a real rm whose only 'trash' is a comment now asks", () => {
    expect(kind("rm -rf ./build # trash")).toBe("ask");
  });
});

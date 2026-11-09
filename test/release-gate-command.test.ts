import { test, expect } from "bun:test";
import { releaseAction } from "../src/policy/release-command";

const merge = (c: string) => expect(releaseAction(c)).toBe("merge");
const tag = (c: string) => expect(releaseAction(c)).toBe("tag");
const none = (c: string) => expect(releaseAction(c)).toBeNull();

test("plain merge and tag are detected", () => {
  merge("gh pr merge 12 --merge --delete-branch");
  merge("gh pr merge");
  tag("git tag v1.2.3");
  tag("git tag -a v1 -m 'release'");
  tag("git tag -f v1");
  tag("git tag -s v1 -m x");
});

test("git commit, push and other commands are never matched", () => {
  none("git commit -m 'WIP gh pr merge git tag v1'");
  none("git commit -am wip");
  none("git push origin feat/x");
  none("gh pr create --title x");
  none("gh pr view 12");
  none("gh pr list");
  none("echo 'gh pr merge 1'");
  none('echo "git tag v1"');
  none("git status && git log --oneline");
});

test("git tag listing/reading is allowed", () => {
  none("git tag");
  none("git tag -l");
  none("git tag --list 'v*'");
  none("git tag -l 'v1.*'");
  none("git tag -n");
  none("git tag --contains abc123");
  none("git tag --points-at HEAD");
  none("git tag --sort=-v:refname");
  none("git tag -v v1");
  none("git tag -d v1");
});

test("hidden after && ; | newline and in bash -c", () => {
  merge("npm test && gh pr merge 3");
  merge("npm test; gh pr merge 3");
  merge("true || gh pr merge 3");
  merge("echo x\ngh pr merge 3");
  tag("git status; git tag v2");
  merge('bash -c "gh pr merge 3"');
  merge("sh -c 'cd x && gh pr merge 3'");
  tag('bash -lc "git tag v9"');
  merge("eval 'gh pr merge 3'");
  merge('bash -c "echo hi; bash -c \'gh pr merge 3\'"');
});

test("env prefix, wrappers, absolute path, quoting", () => {
  merge("GH_TOKEN=x gh pr merge 3");
  merge("FOO=1 BAR=2 gh pr merge 3");
  tag("GIT_COMMITTER_DATE=x git tag v1");
  tag("command git tag v1");
  tag("env GIT_X=1 git tag v1");
  tag("sudo git tag v1");
  merge("nohup gh pr merge 3");
  merge("/opt/homebrew/bin/gh pr merge 3");
  tag("/usr/bin/git tag v1");
  tag("\\git tag v1");
  tag('"git" "tag" v1');
  merge("g''h pr merge 3");
  tag('git tag "v1.0"');
});

test("git global options before the subcommand", () => {
  tag("git -C dir tag v1");
  tag("git -C /a/b -c user.name=x tag v1");
  tag("git --git-dir=.git tag v1");
  tag("git --git-dir .git --work-tree . tag v1");
  tag("git --no-pager tag v1");
  none("git -C dir tag -l");
  none("git -C dir commit -m x");
});

test("gh global options before the subcommand", () => {
  merge("gh -R owner/repo pr merge 3");
  merge("gh --repo owner/repo pr merge 3");
  none("gh -R owner/repo pr view 3");
});

test("substitutions are scanned", () => {
  merge("echo $(gh pr merge 3)");
  tag("x=`git tag v1`");
  merge('echo "$(gh pr merge 3)"');
  none("echo '$(gh pr merge 3)'");
});

test("git commit with a heredoc/substitution message mentioning merge never matches", () => {
  none("git commit -m \"$(cat <<'EOF'\nfix: x\ngh pr merge 3\ngit tag v1\nEOF\n)\"");
});

test("xargs / time wrappers", () => {
  merge("echo 3 | xargs gh pr merge");
  tag("time git tag v1");
});

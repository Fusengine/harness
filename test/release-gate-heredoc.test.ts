import { test, expect } from "bun:test";
import { releaseAction } from "../src/policy/release-command";

const merge = (c: string) => expect(releaseAction(c)).toBe("merge");
const tag = (c: string) => expect(releaseAction(c)).toBe("tag");
const none = (c: string) => expect(releaseAction(c)).toBeNull();

test("release commands appearing only as heredoc TEXT are data, not commands", () => {
  none("gh pr create --title t --body \"$(cat <<'EOF'\n## Gates\n`gh pr merge` needs reports\nEOF\n)\"");
  none("gh pr create --title t --body \"$(cat <<'EOF'\nrun git tag v1.2.3 after\ngit tag v1.2.3\nEOF\n)\"");
  none("gh issue create --body \"$(cat <<'EOF'\ngh pr merge fails\nEOF\n)\"");
  none("cat <<'EOF'\ngit tag v1\nEOF");
  none("cat <<EOF > notes.txt\ngh pr merge 3\nEOF");
  none("cat <<-'EOF'\n\tgit tag v1\n\tEOF");
});

test("a heredoc feeding a shell interpreter is still scanned", () => {
  tag("bash <<'EOF'\ngit tag v1\nEOF");
  merge("sh -s <<EOF\ngh pr merge 3\nEOF");
  merge("cat <<'EOF' | sh\ngh pr merge 3\nEOF");
  tag("bash -x <<'EOF'\necho hi\ngit tag v2\nEOF");
  tag("eval \"$(cat <<'EOF'\ngit tag v1\nEOF\n)\"");
  merge("source /dev/stdin <<'EOF'\ngh pr merge 3\nEOF");
});

test("a release command after the heredoc terminator is still caught; unterminated heredoc fails closed", () => {
  merge("cat <<'EOF'\ntext\nEOF\ngh pr merge 3");
  tag("cat <<'EOF'\ngit tag v1");
});

test("unchanged verdicts: commit with heredoc, push, tag reads, log/describe, gh reads", () => {
  none("git commit -m \"$(cat <<'EOF'\nfix: x\ngh pr merge 3\ngit tag v1\nEOF\n)\"");
  none("git push origin feat/x");
  none("git push --tags");
  none("git tag -l");
  none("git tag -n");
  none("git tag --sort=-v:refname");
  none("git tag -d v1");
  none("git log --tags --oneline");
  none("git describe --tags");
  none("gh pr view 3");
  none("gh pr list");
  none("gh pr checks 3");
  merge("gh pr merge 3 --merge");
  tag("git tag v1.2.3");
});

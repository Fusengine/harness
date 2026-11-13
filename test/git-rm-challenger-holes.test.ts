/**
 * Holes found by the challenger (comments, apostrophes, `$'…'`, brace/IFS/alias,
 * unknown wrappers, xargs-appended operands, linear time) and the named rm-root
 * closures (`rm -Rf /`, `rm -rf "$HOME"`, `/System`, …). Ordinary deletes keep
 * exactly today's verdict.
 */
import { describe, test, expect } from "bun:test";
import { kind } from "./helpers/wrapper-law";
import { releaseAction } from "../src/policy/release-command";
import { expand } from "../src/policy/effective-segments";
import { shellWords, stripComments, substitutions } from "../src/policy/shell-words";

describe("lexing", () => {
  test("comments are dropped, an apostrophe in a comment hides nothing", () => {
    expect(stripComments("a # it's\nb")).toBe("a \nb");
    expect(kind("# don't forget\ngit -C repo reset --hard")).toBe("block");
    expect(kind("git status # what's up\ngit -C repo clean -fd")).toBe("block");
    expect(releaseAction("# don't squash\ngit tag v1.2.3")).toBe("tag");
    expect(stripComments("echo a#b ${#x} $#")).toBe("echo a#b ${#x} $#");
  });
  test("an apostrophe inside double quotes does not hide a substitution", () => {
    expect(substitutions(`echo "it's" $(git push -f)`)).toEqual(["git push -f"]);
    expect(kind(`echo "it's" $(git -C repo push -f origin main)`)).toBe("block");
  });
  test("ANSI-C quoting is resolved", () => {
    expect(shellWords("$'git' push $'-f'")).toEqual(["git", "push", "-f"]);
    expect(shellWords("$'a\\x41\\n'")).toEqual(["aA\n"]);
    expect(kind("$'git' push -f origin main")).toBe("block");
    expect(kind("$'rm' -rf /")).toBe("block");
    expect(kind("$'gh' pr merge 1 --squash")).toBe("block");
  });
  test("comment stripping never hides a release step (both readings are scanned)", () => {
    for (const c of ["echo a\\ #b; gh pr merge 12 --merge", "echo a\\\t#b; gh pr merge 12 --merge", "echo `echo #` ; gh pr merge 12 --merge", "case $(gh pr merge 12) in *) ;; esac", "echo a #b; gh pr merge 12 --merge"]) {
      expect(releaseAction(c)).toBe("merge");
    }
    expect(releaseAction("echo a\\ #b; git tag v1")).toBe("tag");
  });
  test("a backslash inside double quotes keeps the next character (sh -c \"\\gh …\" runs gh)", () => {
    expect(shellWords('"\\gh pr"')).toEqual(["\\gh pr"]);
    expect(releaseAction('sh -c "\\gh pr merge 1"')).toBe("merge");
    expect(releaseAction('sh -c "\\git tag v1"')).toBe("tag");
    for (const c of ['sh -c "\\git -C . push --force origin main"', 'sh -c "\\git -C . reset --hard"', 'sh -c "\\rm -rf /"', 'sh -c "\\gh pr merge --squash 1"']) expect(kind(c)).toBe("block");
    expect(kind('sh -c "\\git -C . commit -m x"')).toBe("ask");
  });
  test("quoted ~ / '$HOME' name a literal file, not home; ordinary quirks stay ordinary", () => {
    for (const c of ["rm -rf '~'", 'rm -rf "~"', "rm -rf \\~", "rm -rf '$HOME'"]) expect(kind(c)).toBe("ask");
    expect(kind('rm -rf "$HOME"')).toBe("block");
    expect(kind("git checkout -B main origin/main")).toBe("ask");
    expect(kind('echo "$IFS" | od -c')).toBe("allow");
    expect(kind('bash "$DIR/my script.sh"')).toBe("allow");
  });
  test("rm of ~- (previous dir) is not a home target", () => {
    expect(kind("rm -rf ~-")).toBe("ask");
  });
  test("linear time on trailing parens and many -exec", () => {
    const t = performance.now();
    kind(`echo ${")".repeat(64000)}`);
    kind(`find . ${"-exec x ".repeat(32000)};`);
    expect(performance.now() - t).toBeLessThan(2000);
  });
  test("linear time on an unclosed-substitution flood", () => {
    const t = performance.now();
    kind(`true # ${"$(".repeat(8000)}\ngit push -f origin main`);
    kind(`echo ${"$(".repeat(8000)} git push -f`);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("fail closed on commands that cannot be read statically", () => {
  test.each(["{git,push,-f,origin,main}", "git${IFS}push${IFS}-f origin main", "git -c alias.p='push --force' p origin main", "sh -c \"$CMD\"", "$CMD push -f"])("%s is opaque -> ask or block", (c) => {
    expect(expand(c).opaque).toBe(true);
    expect(kind(c)).not.toBe("allow");
  });
  test.each(["env -S 'git push -f origin main'", "flock /tmp/l git push -f origin main", "script -q /dev/null git push -f origin main", "find . -exec git push -f \\;", "busybox rm -rf /", "parallel rm -rf ::: /"])("%s is found", (c) => {
    expect(kind(c)).toBe("block");
  });
});

describe("trash waiver cannot be abused", () => {
  test.each(["echo ~ | xargs rm -rf ~/.Trash/x", "find . -exec rm -rf {} + ; rm ~/.Trash/x", "parallel rm -rf ::: ~ ; rm ~/.Trash/x", "rm -rf ~/code/trash/important", "rm -rf ./TRASH/x", "rm -rf ./trashes/x", "rm -rf ~/.Tr''ash/x"])("%s -> not allowed", (c) => {
    expect(kind(c)).not.toBe("allow");
  });
  test("a genuine trash delete stays allowed", () => {
    expect(kind("rm -rf ~/.Trash/old")).toBe("allow");
  });
});

describe("rm of root / home / top-level system dirs is a block in every spelling", () => {
  test.each([
    "rm -rf /", "rm -rf ~", "rm -rf ~/", "rm -rf /*", "rm -rf \"$HOME\"", "rm -rf $HOME", "rm -rf ${HOME}/", "rm -rf ~user", "rm -rf -- /", "rm -rf /.", "rm -rf \"/\"",
    "rm -Rf /", "rm -R -f /", "rm --recursive --force /", "rm -r /", "rm -rf /System", "rm -rf /Library", "rm -rf /Applications", "rm -rf /opt", "rm -rf /private", "rm -rf /Users",
    "rm -rf /home", "rm -rf /root", "rm -rf /Users/me", "rm -rf /home/me/", "rm -rf /Users/*", "sh -c 'rm -rf /'", "cd x && rm -Rf ~/",
  ])("%s -> block", (c) => expect(kind(c)).toBe("block"));
  test.each([
    "rm -rf node_modules", "rm -rf dist", "rm -rf ./build", "rm file.txt", "rm -rf /tmp/x", "rm -rf src/foo", "rm -r ./x", "rm -rf ~/projects/x", "rm -rf $TMPDIR/x",
    "rm -rf /Users/me/proj/x", "rm -rf ./Users", "rm /Users",
  ])("%s keeps its ask", (c) => expect(kind(c)).toBe("ask"));
});

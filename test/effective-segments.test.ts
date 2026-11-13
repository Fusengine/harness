import { describe, test, expect } from "bun:test";
import { expand } from "../src/policy/effective-segments";
import { ungroup } from "../src/policy/command-peel";
import { shellWords } from "../src/policy/shell-words";

const texts = (cmd: string): string[] => expand(cmd).items.map((i) => i.text);

describe("shellWords", () => {
  test("joins adjacent quoted parts and resolves nested single-quote escapes", () => {
    expect(shellWords("sh -c 'git push -f'")).toEqual(["sh", "-c", "git push -f"]);
    expect(shellWords("sh -c 'sh -c '\\''git push -f'\\'''")).toEqual(["sh", "-c", "sh -c 'git push -f'"]);
    expect(shellWords('a"b c"d e\\ f')).toEqual(["ab cd", "e f"]);
    expect(shellWords("echo ''")).toEqual(["echo", ""]);
  });
});

describe("ungroup", () => {
  test.each([
    ["( git push -f )", "git push -f"],
    ["{ git push -f", "git push -f"],
    ["then git push -f", "git push -f"],
    ["do git push -f", "git push -f"],
    ["f() { git push -f", "git push -f"],
    ["case x in x) git push -f", "git push -f"],
    ["echo $(date)", "echo $(date)"],
  ])("%s -> %s", (input, out) => expect(ungroup(input)).toBe(out));
});

describe("expand finds the command behind every wrapper", () => {
  test.each([
    ["git -C x push -f", "git push -f"],
    ["cd x && git -c k=v push --force", "git push --force"],
    ["FOO=1 BAR='a b' git reset --hard", "git reset --hard"],
    ["env -i git push -f", "git push -f"],
    ["xargs -I@ git push -f", "git push -f"],
    ["sudo -u root rm -rf x", "rm -rf x"],
    ["sh -e -c 'git push -f'", "git push -f"],
    ["bash -lc \"git push -f\"", "git push -f"],
    ["eval git push -f", "git push -f"],
    ["( cd x && git push -f )", "git push -f"],
    ["if true; then git push -f; fi", "git push -f"],
    ["f() { git push -f; }; f", "git push -f"],
    ["echo $(git push -f)", "git push -f"],
    ["x=`git push -f`", "git push -f"],
    ["cat <(git push -f)", "git push -f"],
    ["echo 'git push -f' | sh", "git push -f"],
    ["sh <<'EOF'\ngit push -f\nEOF", "git push -f"],
    ["\\git push -f", "git push -f"],
    ["g'i't push -f", "git push -f"],
  ])("%j finds %s", (cmd, wanted) => expect(texts(cmd)).toContain(wanted));

  test("data heredoc bodies and quoted prose are not commands", () => {
    expect(texts("cat <<'EOF'\ngit push -f\nEOF")).not.toContain("git push -f");
    expect(texts("echo \"git push -f\"")).not.toContain("git push -f");
    expect(texts("git commit -m \"git push -f\"")).toEqual(["git commit -m 'git push -f'"]);
    expect(texts("echo '$(git push -f)'")).not.toContain("git push -f");
  });

  test("an argument holding whitespace stays one quoted unit", () => {
    expect(texts("git log --grep \"git reset --hard\"")).toEqual(["git log --grep 'git reset --hard'"]);
  });

  test("fails closed: dynamic or too-deep shell payloads are opaque", () => {
    expect(expand("sh -c \"$CMD\"").opaque).toBe(true);
    expect(expand("bash -c \"$(cat f)\"").opaque).toBe(true);
    expect(expand("sh -c 'a'").opaque).toBe(false);
    let deep = "git push -f";
    for (let i = 0; i < 12; i++) deep = `sh -c '${deep.replaceAll("'", "'\\''")}'`;
    expect(expand(deep).opaque).toBe(true);
  });
});

/**
 * The rm confirmation is waived only for a delete INSIDE a trash directory.
 * The word "trash" anywhere else (comment, echo, file name) exempts nothing;
 * `mv x ~/.Trash/` is no rm and stays allowed. Wrapped forms keep the verdict.
 */
import { describe, test, expect } from "bun:test";
import { kind } from "./helpers/wrapper-law";

describe("rm with the word trash somewhere else still asks", () => {
  test.each([
    "rm -rf ./x # trash",
    "echo trash; rm -rf ./x",
    "rm -rf ./trash-me",
    "rm ./trash.txt",
    "rm -rf ./Trash/../x",
    "rm -rf ~/.Trash",
    "rm -rf $HOME/.Trash/x",
    "rm -rf ~/.Trash/$X",
    "rm -rf ~/.Trash/x ./other",
    "rm -rf ~/.Trash/x # but also\nrm ./y",
    "rm -rf ~/.Trash/x && rm ./y",
    "rm -rf ~/.Trash/{a,b}",
    "unlink ~/.Trash/x",
  ])("%j -> ask", (c) => expect(kind(c)).toBe("ask"));
});

describe("a delete inside a trash dir is exempt", () => {
  test.each([
    "rm -rf ~/.Trash/old",
    "rm ~/.Trash/x",
    "rm -rf /Users/me/.Trash/a /Users/me/.Trash/b",
    "rm -rf ~/.Trash/*",
    "rm -rf -- ~/.Trash/-weird",
    "rm -rf ~/.local/share/Trash/files/x",
    "rm -rf /tmp/proj/.trash/cache",
  ])("%s -> allow", (c) => expect(kind(c)).toBe("allow"));
});

describe("moving to the trash is no rm", () => {
  test.each(["mv x ~/.Trash/", "mv ./a ~/.Trash/a", "trash-put ./x", "gio trash ./x", "echo trash", "ls ~/.Trash"])("%s -> allow", (c) => expect(kind(c)).toBe("allow"));
});

describe("wrappers keep both verdicts", () => {
  const W = ["sh -c '{C}'", "bash -c \"{C}\"", "cd x && {C}", "( {C} )", "{ {C}; }", "FOO=1 {C}", "xargs {C}", "echo '{C}' | sh", "eval '{C}'"];
  test.each(W)("%s", (w) => {
    expect(kind(w.replace("{C}", "rm -rf ./x # trash"))).not.toBe("allow");
    expect(kind(w.replace("{C}", "rm -rf ./trash-me"))).not.toBe("allow");
    // `eval` itself always asks (pre-existing), so only the other wrappers can show the plain allow.
    if (!w.startsWith("eval")) expect(kind(w.replace("{C}", "mv ./x ~/.Trash/"))).toBe("allow");
  });
  test("a quoted critical target no longer hides behind the closing quote", () => {
    expect(kind("sh -c 'rm -rf /'")).toBe("block");
    expect(kind("sh -c 'rm -rf ~'")).toBe("block");
    expect(kind("bash -c \"rm -rf /etc/x\"")).toBe("block");
  });
});

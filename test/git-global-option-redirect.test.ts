/** Lead battery rows: global-option git forms and a force push with an output redirect are gated like the bare command. */
import { describe, test, expect } from "bun:test";
import { kind } from "./helpers/wrapper-law";

describe("git behind global options keeps the bare verdict", () => {
  test("git -C x commit asks (bare git commit asks)", () => {
    expect(kind("git commit -m msg")).toBe("ask");
    expect(kind("git -C x commit -m msg")).toBe("ask");
    expect(kind("git -C x -c user.name=a commit -m msg")).toBe("ask");
  });
  test("git -C x push --force blocks (bare blocks)", () => {
    expect(kind("git push --force origin main")).toBe("block");
    expect(kind("git -C x push --force origin main")).toBe("block");
    expect(kind("git --git-dir=.git push -f")).toBe("block");
  });
  test("git part of a force push with a redirect is a block (never weaker than the bare git verdict)", () => {
    for (const c of ["git push --force x > /tmp/f", "git push --force x >> /tmp/f", "git -C y push -f x > /tmp/f 2>&1"]) expect(kind(c)).toBe("block");
  });
});

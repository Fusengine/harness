/**
 * Each cp / mv / install / ln destination is judged against ITS OWN proven root (the git top-level, else the
 * nearest manifest, of the nearest existing directory of the destination), not the payload cwd's root:
 * `cd other-repo && cp /tmp/x t.ts` is refused from repo A exactly as it is from repo B itself.
 * A destination with no provable root keeps the base verdict.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGitInit } from "../helpers/monotone-git";
import { guardVerdict } from "../helpers/monotone-guard";

let a = ""; // repo A: the payload cwd
let b = ""; // repo B: the destination
let loose = ""; // no git, no manifest
let npm = ""; // manifest-only project (no git)

const fromA = (command: string): "allow" | "ask" | "block" => guardVerdict(command, a);

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-cpmv-dest-")));
  a = join(base, "a");
  b = join(base, "b");
  loose = join(base, "loose");
  npm = join(base, "npm");
  for (const r of [a, b, npm]) mkdirSync(join(r, "src"), { recursive: true });
  mkdirSync(loose, { recursive: true });
  safeGitInit(a);
  safeGitInit(b);
  writeFileSync(join(npm, "package.json"), "{}\n");
  for (const f of [join(a, "src/a.ts"), join(a, "notes.txt"), join(b, "src/b.ts"), join(b, "notes.txt"), join(npm, "src/n.ts")]) writeFileSync(f, "x\n");
});

describe("a destination in another repo is judged by that repo (payload cwd in repo A)", () => {
  test("every spelling of a temp / non-code source onto repo B code is refused", () => {
    for (const cmd of [
      () => `cd ${b} && cp /tmp/x t.ts`,
      () => `cp /tmp/x ${b}/src/t.ts`,
      () => `mv /tmp/x ${b}/src/t.ts`,
      () => `install /tmp/x ${b}/src/t.ts`,
      () => `ln -s /tmp/x ${b}/src/t.ts`,
      () => `cd ${b} && cp notes.txt src/n.ts`,
      () => `cd ${b} && cp ${b}/notes.txt src/n.ts`,
      () => `cp ${a}/notes.txt ${b}/src/n.ts`,
      () => `cp -t ${b}/src /tmp/x.ts`,
      () => `cd ${b} && mv /tmp/x t.ts`,
      () => `cd ${b}/src && cp /tmp/x t.ts`,
    ]) expect(fromA(cmd()), cmd()).toBe("block");
  });
  test("the same spelling from repo B itself is refused too (control)", () => {
    expect(guardVerdict("cp /tmp/x t.ts", b)).toBe("block");
    expect(guardVerdict(`cp /tmp/x ${b}/src/t.ts`, b)).toBe("block");
  });
  test("a code file from a git repo that itself lives in temp is a temp source: refused", () => {
    expect(fromA(`cp ${a}/src/a.ts ${b}/src/a.ts`)).toBe("block");
    expect(fromA(`cd ${b} && cp ${a}/src/a.ts src/a.ts`)).toBe("block");
  });
  // OWNER DECISION 2026-11-11 21:45 (OTHER_PROVEN_ROOT_IS_FOREIGN = false in bash-write-cpmv-source.ts): a code source
  // under ANOTHER proven root outside temp (sibling repo, worktree, linked package) keeps the base verdict.
  // The source is this checkout's own file: a proven root (git) that lives outside temp, unlike the fixtures.
  const realSrc = join(import.meta.dir, "../../src/policy/guards/bash-write-cpmv.ts");
  const outsideTemp = !realpathSync(realSrc).startsWith(realpathSync(tmpdir()));
  (outsideTemp ? test : test.skip)("a code source under ANOTHER proven root outside temp is allowed", () => {
    for (const cmd of [`cp ${realSrc} ${b}/src/n.ts`, `cd ${b} && cp ${realSrc} src/n.ts`, `cd ${b}/src && mv ${realSrc} m.ts`, `cp ${realSrc} ${npm}/src/n.ts`]) expect(fromA(cmd), cmd).toBe("allow");
  });
  (outsideTemp ? test : test.skip)("...but temp sources and non-code sources are still refused", () => {
    expect(fromA(`cp /tmp/x ${b}/src/n.ts`)).toBe("block");
    expect(fromA(`cp ${join(realSrc, "../../../../package.json")} ${b}/src/n.ts`)).toBe("block");
  });
  test("content already inside the destination's repo stays allowed", () => {
    for (const cmd of [`cd ${b} && cp src/b.ts src/c.ts`, `cp ${b}/src/b.ts ${b}/src/c.ts`, `cd ${b} && mv src/b.ts src/d.ts`, `cd ${b}/src && cp b.ts e.ts`]) expect(fromA(cmd), cmd).toBe("allow");
  });
  test("non-code destinations and temp destinations are not judged", () => {
    for (const cmd of [`cp /tmp/x ${b}/notes2.txt`, `cd ${b} && cp /tmp/x out.txt`, `cp ${b}/src/b.ts /tmp/b.ts`]) expect(fromA(cmd), cmd).toBe("allow");
  });
  test("a manifest-only project is its own root", () => {
    expect(fromA(`cp /tmp/x ${npm}/src/t.ts`)).toBe("block");
    expect(fromA(`cp ${npm}/src/n.ts ${npm}/src/m.ts`)).toBe("allow");
  });
  test("a destination with no provable root keeps the base verdict", () => {
    for (const cmd of [`cp /tmp/x ${loose}/t.ts`, `cd ${loose} && cp /tmp/x t.ts`]) expect(fromA(cmd), cmd).toBe("allow");
  });
  test("a destination that does not exist yet is judged by its nearest existing directory", () => {
    expect(fromA(`cp /tmp/x ${b}/src/new/deeper/t.ts`)).toBe("block");
    expect(fromA(`cp ${b}/src/b.ts ${b}/src/new/deeper/t.ts`)).toBe("allow");
  });
});

describe("the project root may itself live under a temp directory", () => {
  test("a source inside the temp-rooted project stays allowed; one in temp outside it is refused", () => {
    for (const cmd of [`cd ${b} && cp src/b.ts src/c.ts`, `cd ${b} && cp ${b}/src/b.ts src/c.ts`]) expect(guardVerdict(cmd, tmpdir()), cmd).toBe("allow");
    expect(guardVerdict(`cd ${b} && cp ${a}/src/a.ts src/c.ts`, tmpdir())).toBe("block");
    expect(guardVerdict(`cd ${b} && cp /tmp/x.ts src/c.ts`, tmpdir())).toBe("block");
  });
});

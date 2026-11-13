/**
 * cp / mv of a directory tree from outside the project: judged by what the tree holds on disk
 * (split out of cpmv.test.ts; same fixture layout: `base/proj` is the git root, cwd `base/proj/sub`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTree } from "../../src/policy/guards/bash-write-cpmv-tree";
import { safeGitInit } from "../helpers/monotone-git";
import { guardVerdict } from "../helpers/monotone-guard";

let sub = "";
let trees = "";

const verdict = (command: string): "allow" | "ask" | "block" => guardVerdict(command, sub);

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-cpmv-trees-")));
  const root = join(base, "proj");
  sub = join(root, "sub");
  mkdirSync(sub, { recursive: true });
  safeGitInit(root);
  // directory-tree sources outside the project
  trees = join(base, "trees");
  for (const d of ["assets", "withcode/sub", "linked", "locked"]) mkdirSync(join(trees, d), { recursive: true });
  for (const f of ["assets/a.png", "assets/b.png", "withcode/sub/deep.ts", "withcode/notes.md", "locked/x.png"]) writeFileSync(join(trees, f), "x\n");
  symlinkSync(join(trees, "withcode"), join(trees, "linked/l")); // a link to a tree with code: never followed
  chmodSync(join(trees, "locked"), 0);
});

afterAll(() => {
  chmodSync(join(trees, "locked"), 0o755); // so the OS temp cleaner can remove it
});

describe("directory trees from outside the project are judged by what they hold", () => {
  test("a tree without code keeps the aa1d13c verdict (allow)", () => {
    for (const cmd of [`cp -r ${trees}/assets docs/man`, "cp -r ../../trees/assets public/", `cp -r ${trees}/linked vendor/`, `mv ${trees}/assets docs/`, "cp -r ~/templates/foo ./"]) {
      expect(verdict(cmd), cmd).toBe("allow");
    }
  });
  test("a tree holding at least one code file is refused", () => {
    for (const cmd of [`cp -r ${trees}/withcode docs/`, `cp -r ${trees}/withcode docs/x`, `mv ${trees}/withcode public/`, "cp -r ../../trees/withcode public/"]) {
      expect(verdict(cmd), cmd).toBe("block");
    }
  });
  test("an unreadable or over-bound tree cannot be proven: the base verdict (allow), never an ask", () => {
    expect(verdict(`cp -r ${trees}/locked docs/`)).toBe("allow");
    const before = process.env.FUSE_CPMV_TREE_MAX;
    process.env.FUSE_CPMV_TREE_MAX = "1";
    try { expect(verdict(`cp -r ${trees}/assets docs/`)).toBe("allow"); } finally {
      if (before === undefined) delete process.env.FUSE_CPMV_TREE_MAX; else process.env.FUSE_CPMV_TREE_MAX = before;
    }
  });
  test("scanTree: code found / clean / links not followed / missing", () => {
    expect(scanTree(join(trees, "withcode"))).toBe("code");
    expect(scanTree(join(trees, "assets"))).toBe("clean");
    expect(scanTree(join(trees, "linked"))).toBe("clean");
    expect(scanTree(join(trees, "does-not-exist"))).toBe("unknown");
    expect(scanTree(join(trees, "linked"), true)).toBe("code"); // cp -L follows the link to a tree with code
    expect(verdict(`cp -rL ${trees}/linked docs/`)).toBe("block");
  });
});

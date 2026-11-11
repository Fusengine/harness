/**
 * Round-6 regressions (the owner's "ne me fais pas de regression"): the cp/mv layer ONLY tightens and only on
 * proof. (a) it never lowers another guard's verdict (no ask over a deny); (b) run-time sources, unknown cwd,
 * a project without git, big or unreadable trees keep the aa1d13c verdict; LAW: the final verdict is never
 * weaker than the base verdict, whatever the command.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseBashWriteGuard, bashWriteGuard } from "../../src/policy/guards/bash-write";
import { safeGitInit } from "../helpers/monotone-git";
import { guardVerdict } from "../helpers/monotone-guard";
import { HOSTS, hostDecision } from "../helpers/monotone-verdict";

let proj = "";
let np = "";
let noread = "";
let big = "";
let loop = "";

const RANK = { allow: 0, ask: 1, block: 2 } as const;
const rank = (p: ReturnType<typeof bashWriteGuard>): number => RANK[p === null ? "allow" : p.kind === "ask" ? "ask" : "block"];

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-cpmv-reg-")));
  proj = join(base, "proj");
  np = join(base, "np");
  noread = join(base, "noread");
  big = join(base, "big");
  loop = join(base, "loop");
  for (const d of [join(proj, "src"), join(proj, "docs"), join(np, "lib"), join(np, "src"), noread, big, join(loop, "l1")]) mkdirSync(d, { recursive: true });
  safeGitInit(proj);
  writeFileSync(join(proj, "src/a.ts"), "x\n");
  writeFileSync(join(np, "package.json"), "{}\n"); // a non-git project: the manifest marks its root
  for (const f of [join(np, "lib/u.ts"), join(np, "src/m.ts"), join(noread, "z.png")]) writeFileSync(f, "x\n");
  for (let i = 0; i < 12; i++) writeFileSync(join(big, `p${i}.png`), "x\n");
  symlinkSync(loop, join(loop, "l1/back")); // a link loop
  chmodSync(noread, 0);
});

afterAll(() => chmodSync(noread, 0o755));

describe("(a) the layer never lowers another guard's deny", () => {
  const TAILS = ["git push --force origin main", "git reset --hard HEAD~3", 'echo "export const x=1" > src/a.ts'];
  for (const host of HOSTS) {
    test(host, async () => {
      for (const head of ["cp -r NOREAD docs/nr", "cp -r BIG docs/b", "cp -rL LOOP docs/l", "cp -r /usr/share docs/share"]) {
        for (const tail of TAILS) {
          const cmd = `${head.replace("NOREAD", noread).replace("BIG", big).replace("LOOP", loop)}; ${tail}`;
          const lone = await hostDecision(host, tail);
          expect(await hostDecision(host, cmd), cmd).toBe(lone);
        }
      }
    });
  }
});

describe("(b) what cannot be proven keeps the base verdict", () => {
  test("run-time sources onto one code file, pushd, cd to a missing dir", () => {
    for (const cmd of [
      "cp $PWD/src/a.ts src/a11.ts", "cp ${PWD}/src/a.ts src/a12.ts", 'cp "$(pwd)/src/a.ts" src/a13.ts', "cp `pwd`/src/a.ts src/a14.ts",
      "cp $(git rev-parse --show-toplevel)/src/a.ts src/a16.ts", "f=src/a.ts; cp $f src/a15.ts", "pushd src && cp a.ts c.ts && popd", "cd nonexist && cp src/a.ts src/b.ts",
    ]) expect(guardVerdict(cmd, proj), cmd).toBe("allow");
  });
  test("a non-git project with cwd in a subfolder (root = nearest manifest)", () => {
    for (const cmd of ["cp ../lib/u.ts u.ts", "cp ../lib/u.ts ./", "cp -r ../lib ./lib2", "cp m.ts m2.ts"]) expect(guardVerdict(cmd, join(np, "src")), cmd).toBe("allow");
  });
  test("a big, unreadable or looping tree cannot be proven to hold code", () => {
    const before = process.env.FUSE_CPMV_TREE_MAX;
    process.env.FUSE_CPMV_TREE_MAX = "5";
    try {
      for (const cmd of [`cp -r ${big} assets/big`, `cp -R ${big}/ public/images/`, `cp -r ${noread} docs/nr`, `cp -rL ${loop} docs/l`, `cp -r ${loop} docs/l`]) {
        expect(guardVerdict(cmd, proj), cmd).toBe("allow");
      }
    } finally {
      if (before === undefined) delete process.env.FUSE_CPMV_TREE_MAX; else process.env.FUSE_CPMV_TREE_MAX = before;
    }
  });
});

describe("tilde in sources: only an unquoted leading ~ or ~/ is the home directory", () => {
  test("quoted, escaped, ~+, ~-, ~user are 'cannot tell': the base verdict stands", () => {
    for (const cmd of [
      'cp "~/x.ts" src/a.ts', "cp '~/x.ts' src/a.ts", "cp \\~/x.ts src/a.ts", 'mv "~/x.ts" src/c.ts', 'ln "~/x.ts" src/d.ts', 'ln -s "~/x.ts" src/d.ts', 'cp "~"/x.ts src/a.ts',
      'cp -r "~" vendor/', "cp -r '~/bin' vendor/", "cd .. && cp ~-/src/b.ts proj/src/a.ts", "cd .. && cp ~+/proj/src/b.ts proj/src/a.ts", "cp ~root/x.ts src/a.ts",
    ]) expect(guardVerdict(cmd, proj), cmd).toBe("allow");
  });
  test("an unquoted ~ / ~/ stays the home directory, outside the proven root: refused", () => {
    for (const cmd of ["cp ~/x.ts src/a.ts", 'cp ~/"a b.ts" src/a.ts', "mv ~/x.ts src/c.ts", "install ~/tool.ts src/t.ts"]) expect(guardVerdict(cmd, proj), cmd).toBe("block");
  });
});

describe("LAW: the final verdict is never weaker than the base verdict", () => {
  test("over every row of this deliverable (and the c6 corpora)", () => {
    const rows = [
      "cp /tmp/x t.ts", "mv /tmp/x t2.ts", "cp s.txt src/x.ts", "cp a.ts b.ts", "cp -r src backup", "git push --force origin main", "cp /tmp/x t.ts; git push --force origin main",
      `cp -r ${noread} docs/nr; git push --force origin main`, `cp -r ${big} docs/b`, "cp $PWD/src/a.ts src/a11.ts", "echo hi > out.txt", "echo hi > src/a.ts", "ls > /tmp/x && cp /tmp/x src/y.ts",
      "sed -i s/a/b/ src/a.ts", "cd nonexist && cp /tmp/x src/b.ts", `cp -r ${loop} docs/l`, "cp -r /usr/share/man docs/man", "install -m 644 /tmp/x src/x.ts", "ln -sf /etc/hosts src/x.ts",
    ];
    for (const cmd of rows) {
      const ctx = { tool: "Bash", command: cmd, cwd: proj };
      expect(rank(bashWriteGuard(ctx)), cmd).toBeGreaterThanOrEqual(rank(baseBashWriteGuard(ctx)));
    }
  });
});

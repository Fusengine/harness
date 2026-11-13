/**
 * cp / mv / install / ln onto a project code file: the layer only TIGHTENS, and only on PROOF.
 * It blocks when the destination is a literal, resolved project code file and the source is literal and
 * provably (i) in a temp/scratchpad dir, (ii) a non-code file, or (iii) outside a proven project root.
 * Every uncertainty (variables, unknown cwd, no proven root, placeholders) keeps the aa1d13c verdict.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_ATOMS, EXTRA_DENY_ATOMS, GAP_ATOMS, NONCODE_DST_ATOMS } from "../helpers/monotone-atoms";
import { COMPOUND_IDS, execCases } from "../helpers/monotone-contexts";
import { safeGitInit } from "../helpers/monotone-git";
import { guardVerdict } from "../helpers/monotone-guard";

let root = "";
let sub = "";
let outside = "";

const verdict = (command: string, cwd: string = sub): "allow" | "ask" | "block" => guardVerdict(command, cwd);

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-cpmv-")));
  root = join(base, "proj");
  sub = join(root, "sub");
  outside = join(base, "outside");
  for (const d of [join(sub, "d"), join(root, "src"), outside]) mkdirSync(d, { recursive: true });
  safeGitInit(root);
  for (const f of [join(root, "a.ts"), join(root, "src/a.ts"), join(sub, "old.ts"), join(outside, "s.ts")]) writeFileSync(f, "x\n");
  symlinkSync(root, join(base, "proj-link"));
});

describe("refused: a source that provably is not project code lands in a project code file", () => {
  for (const atom of [...GAP_ATOMS, ...EXTRA_DENY_ATOMS]) {
    test(`${atom.id}: bare, in compound bodies, after cd into an existing dir`, () => {
      expect(verdict(atom.cmd)).toBe("block");
      for (const c of execCases([atom], 1).filter((x) => x.chain[0] && COMPOUND_IDS.has(x.chain[0].id))) expect(verdict(c.cmd), c.cmd).toBe("block");
      if (!atom.cmd.includes("..")) expect(verdict(`cd d && ${atom.cmd}`)).toBe("block"); // (`..` resolves from the new directory)
    });
  }
  test("non-code sources, backups included: `.bak`/`.orig` onto a code file", () => {
    for (const cmd of ["cp src/a.ts.bak src/a.ts", "mv a.ts.orig src/a2.ts", "cp notes.md src/a3.ts", "cp ~/Downloads/x.txt src/x.ts"]) expect(verdict(cmd), cmd).toBe("block");
  });
  test("temp, scratchpad and sources outside the proven root", () => {
    for (const cmd of [`cp ${outside}/s.ts src/x.ts`, "cp ../../outside/s.ts src/x.ts", "cp /tmp/s.ts ./src/x.ts", `cd ${outside} && cp s.ts ${root}/src/x.ts`]) expect(verdict(cmd), cmd).toBe("block");
  });
});

describe("cannot be proven: the aa1d13c verdict stands (allow)", () => {
  test("run-time sources and an unknown cwd", () => {
    for (const cmd of [
      "cp $SRC src/x.ts", "cp $PWD/src/a.ts src/a11.ts", 'cp "$(pwd)/a.ts" src/x.ts', "cp `pwd`/a.ts src/x.ts", "f=src/a.ts; cp $f src/a15.ts", "cp $D/foo.ts src/",
      "pushd src && cp a.ts c.ts && popd", "cd nonexist && cp ../src/a.ts b.ts", "cd $D && cp a.ts src/x.ts", `pushd ${outside} && cp s.ts ${root}/src/b.ts`,
      `find ${outside} -name '*.ts' -exec cp {} src/ \\;`, "echo a | xargs -I{} cp {} src/b.ts", "cp {a,b}.ts src/x.ts",
    ]) expect(verdict(cmd), cmd).toBe("allow");
  });
  test("code to code inside the project", () => {
    for (const atom of ALLOW_ATOMS.filter((a) => a.id !== "git-mv-code")) expect(verdict(atom.cmd, root), atom.cmd).toBe("allow");
    for (const cmd of ["cp a.ts b.ts", "mv old.ts new.ts", "cp ../a.ts b.ts", "cp ../src/a.ts b.ts", "ln -s ../a.ts b.ts"]) expect(verdict(cmd), cmd).toBe("allow");
    expect(verdict("cp a.ts b.ts", join(root, "..", "proj-link"))).toBe("allow");
  });
});

describe("unchanged from aa1d13c", () => {
  const SAME: Array<[string, "allow"]> = [
    ["cp a.ts b.ts", "allow"], ["mv old.ts new.ts", "allow"], ["git mv old.ts new.ts", "allow"], ["cp -r src/ backup/", "allow"], ["cp file.ts /tmp/", "allow"],
    ["cp notes.md notes2.md", "allow"], ["mv a.md docs/", "allow"], ["install -m 755 build/x bin/x", "allow"], ["ln -s ../a.ts b.ts", "allow"], ["cp s.txt out.txt", "allow"],
    ["mv s.txt out.log", "allow"], ["ln -sf s.txt out.lnk", "allow"], ["cp -vt /tmp a.ts", "allow"], ["(cd /tmp && ls); cp a.ts b.ts", "allow"], ["cp /dev/null src/a.ts", "allow"],
    ["git commit -m \"cp x t.ts\"", "allow"], ["echo \"mv a b.ts\"", "allow"], ["cp *.md docs/", "allow"], ["mv /tmp/build.js /tmp/dist.js", "allow"], ["install -d build dist src/gen.ts", "allow"],
    ["cp /tmp/tool.py ~/bin/tool.py", "allow"], ["cp /tmp/x.ts ~/", "allow"], ["install -m 755 /tmp/tool.py ~/bin/tool.py", "allow"], ["ln -s /tmp/tool.py ~/bin/tool.py", "allow"],
    ["cp -t ~/bin ../../outside/y.ts", "allow"], ["cp -r ../../outside ~/.config/codetree", "allow"],
  ];
  for (const [cmd, want] of SAME) test(cmd, () => expect(verdict(cmd)).toBe(want));
  test("non-code destinations", () => {
    for (const a of NONCODE_DST_ATOMS) expect(verdict(a.cmd), a.cmd).toBe("allow");
  });
});

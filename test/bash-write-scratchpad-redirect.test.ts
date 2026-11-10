import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";

/** Owner's session scratchpad as it appears in the Claude Code payload (`scratchpad_dir`). */
const OWNER_D = "/private/tmp/claude-501/-Users-brunoazoulay-Labo-docker-lab-dev-local-Dev-ai-claude-code-fuse-harness/a5af2a9f-7ce7-4a24-a606-ba69f9397668/scratchpad";
/** Owner's command with `cd <dir>` pointed at an existing directory (the guard checks it at hook time). */
const ownerCmd = (cwd: string): string => `cd ${cwd} && S=${OWNER_D}; HOME=$S/carto-home timeout 560 bun test > $S/carto-full-test2.log 2>&1; tail -6 $S/carto-full-test2.log`;

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-redir-")));
const D = join(root, "claude-501", "-proj", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", "scratchpad");
const P = join(root, "proj");
mkdirSync(D, { recursive: true });
mkdirSync(join(P, "src"), { recursive: true });
writeFileSync(join(P, "src", "a.txt"), "project\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Verdict = "allow" | "ask" | "block";
/** Verdict with the payload scratchpad dir `dir` (default `D`; `null` = field absent). */
function v(command: string, dir: string | null = D): Verdict {
  const r = bashWriteGuard({ tool: "Bash", command, scratchpadDir: dir ?? undefined });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

describe("owner's exact command and the shapes it generalizes to", () => {
  test("the screenshot command passes with the payload scratchpad_dir, asks without", () => {
    expect(v(ownerCmd(P), OWNER_D)).toBe("allow");
    expect(v(ownerCmd(`${P}/missing`), OWNER_D)).toBe("ask");
    expect(bashWriteGuard({ tool: "Bash", command: ownerCmd(P) })?.kind).toBe("ask");
    expect(bashWriteGuard({ tool: "Bash", command: ownerCmd(P) })?.ruleId).toBe("bash-write:file-redirect");
  });
  test("pipeline into a scratchpad file passes", () => {
    expect(v(`ls /x/skills | sort -u > ${D}/skills.txt`)).toBe("allow");
  });
  test("append, fd-prefixed and dup forms pass", () => {
    expect(v(`echo x >> ${D}/log.txt`)).toBe("allow");
    expect(v(`echo x 2> ${D}/err.txt`)).toBe("allow");
    expect(v(`echo x > ${D}/o.txt 2>&1`)).toBe("allow");
    expect(v(`echo x > "${D}/o.txt"`)).toBe("allow");
  });
});

describe("one unsafe target or ambiguity keeps the old verdict", () => {
  test("mixed targets, either order", () => {
    expect(v(`echo x > ${D}/a > ${P}/b`)).toBe("ask");
    expect(v(`echo x > ${P}/b > ${D}/a`)).toBe("ask");
    expect(v(`echo x > ${D}/a; echo y > ${P}/b`)).toBe("ask");
  });
  test("variable reassigned, command-substituted, late, exported or prefix-form", () => {
    expect(v(`S=${D}; S=${P}/src; echo x > $S/x.log`)).toBe("ask");
    expect(v(`S=$(pwd); echo x > $S/x`)).toBe("ask");
    expect(v(`echo x > $S/x; S=${D}`)).toBe("ask");
    expect(v(`export S=${D}; echo x > $S/x`)).toBe("ask");
    expect(v(`S=${D} echo x > $S/x`)).toBe("ask");
    expect(v(`S=${P}; echo x > $S/x.log`)).toBe("ask");
  });
  test("traversal, depth 2, trailing slash, sibling and lookalike", () => {
    expect(v(`echo x > ${D}/../../proj/x`)).toBe("ask");
    expect(v(`echo x > ${D}/sub/x`)).toBe("ask");
    expect(v(`echo x > ${D}x/a`)).toBe("ask");
    expect(v(`echo x > ${P}/scratchpad/x`)).toBe("ask");
    expect(v(`echo x > ${root}/claude-501/-proj/bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb/scratchpad/x`)).toBe("ask");
  });
  test("code-file targets stay a BLOCK, never relaxed", () => {
    expect(v(`echo x > ${D}/x.ts`)).toBe("block");
    expect(v(`S=${D}; echo x > $S/x.ts`)).toBe("block");
    expect(v(`echo x > ${D}/x.PY`)).toBe("block");
  });
  test("no scratchpad_dir, or an unusable one, keeps the old ask", () => {
    for (const bad of [null, "", "scratchpad", "/", "/tmp", `${D}/../..`, `${D}/./`, "/a b/c/d"]) {
      expect(v(`echo x > ${D}/a`, bad), String(bad)).toBe("ask");
    }
  });
});

describe("links: command-created and pre-existing", () => {
  test("link-creating invocations anywhere keep asking", () => {
    expect(v(`ln -s ${P}/src/a $S/l; echo x > ${D}/l`)).toBe("ask");
    expect(v(`S=${D}; ln -s ${P}/src/a $S/l; echo x > $S/l`)).toBe("ask");
    expect(v(`cp -s ${P}/f ${D}/a; echo x > ${D}/a`)).toBe("ask");
    expect(v(`cp --link ${P}/f ${D}/a; echo x > ${D}/a`)).toBe("ask");
    expect(v(`link ${P}/f ${D}/a; echo x > ${D}/a`)).toBe("ask");
  });
  test("pre-existing symlink, directory and hard link at the target keep asking", () => {
    symlinkSync(join(P, "src", "a.txt"), join(D, "sym"));
    mkdirSync(join(D, "adir"));
    linkSync(join(P, "src", "a.txt"), join(D, "hard"));
    expect(v(`echo x > ${D}/sym`)).toBe("ask");
    expect(v(`echo x > ${D}/adir`)).toBe("ask");
    expect(v(`echo x > ${D}/hard`)).toBe("ask");
  });
  test("existing regular file and a not-yet-created file pass", () => {
    writeFileSync(join(D, "reg.txt"), "");
    expect(v(`echo x > ${D}/reg.txt`)).toBe("allow");
    expect(v(`echo x > ${D}/new.txt`)).toBe("allow");
  });
});

describe("ordering, runners and bounded work", () => {
  test("a runner may own a redirect, but no redirect may follow it", () => {
    expect(v(`bun test > ${D}/a.log 2>&1; tail -6 ${D}/a.log`)).toBe("allow");
    expect(v(`echo x > ${D}/a; bun test > ${D}/b`)).toBe("allow");
    expect(v(`bun test > ${D}/a.log; echo x > ${D}/b.log`)).toBe("ask");
    expect(v(`bun test 2>&1 | tail -5 > ${D}/a.log`)).toBe("ask");
    expect(v(`bun test > ${D}/a.log 2>&1 &`)).toBe("ask");
  });
  test("only read-only commands and test/build runners are in the window", () => {
    for (const cmd of ["python3 tool.py", "git checkout -- x", "chmod 000 x", "touch x", "ls | sort -o x", "rg --pre ./e x"]) {
      expect(v(`${cmd} > ${D}/o.log`), cmd).toBe("ask");
    }
  });
  test("a command over the 4096-char cap skips the window (bounded work, no wall-clock assertion)", () => {
    const big = `S=${D}; ${"echo i > $S/f; ".repeat(5000)}`;
    expect(big.length).toBeGreaterThan(4096);
    expect(v(big)).toBe("ask");
    const head = `S=${D}; `;
    const unit = "echo i > $S/f; ";
    const fits = `${head}${unit.repeat(Math.floor((4000 - head.length) / unit.length))}`;
    expect(fits.length).toBeLessThanOrEqual(4096);
    expect(v(fits)).toBe("allow");
  });
  test("a conditional S= binding asks; only an unconditional one or cd <existing dir> && S= passes", () => {
    expect(v(`cd /nonexistent && S=${D}; echo x > $S/a`)).toBe("ask");
    expect(v(`false && S=${D}; echo x > $S/a`)).toBe("ask");
    expect(v(`true ||\nS=${D}; echo x > $S/a`)).toBe("ask");
    expect(v(`cd ${P} && S=${D}; echo x > $S/a`)).toBe("allow");
    expect(v(`cd ${join(P, "src", "a.txt")} && S=${D}; echo x > $S/a`)).toBe("ask");
  });
});

describe("the window never makes a command more permissive than without its redirects", () => {
  test("later ask-tier writers still ask", () => {
    expect(v(`echo x | tee ${P}/notes.txt > ${D}/b`)).toBe("ask");
    expect(v(`dd if=/dev/zero of=${P}/blob > ${D}/b`)).toBe("ask");
  });
  test("nested shells, eval, exec and process substitution keep asking", () => {
    expect(v(`bash -c "echo x > ${P}/b" > ${D}/log`)).toBe("ask");
    expect(v(`eval "echo x > ${P}/b" > ${D}/log`)).toBe("ask");
    expect(v(`cmd >(tee ${P}/b) > ${D}/log`)).toBe("ask");
  });
  test("an operator the redirect scanner cannot see keeps asking", () => {
    expect(v(`echo x > ${D}/a &> ${P}/b`)).toBe("ask");
    expect(v(`echo x > ${D}/a >& ${P}/b`)).toBe("ask");
    expect(v(`echo x > ${D}/a <> ${P}/b`)).toBe("ask");
  });
});

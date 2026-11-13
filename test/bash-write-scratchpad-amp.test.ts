import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { askNow } from "./helpers/redir-corpus";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-amp-")));
const D = join(root, "claude-501", "-proj", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", "scratchpad");
const P = join(root, "proj");
mkdirSync(D, { recursive: true });
mkdirSync(P, { recursive: true });
writeFileSync(join(P, "f.txt"), "project\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Verdict = "allow" | "ask" | "block";
/** Verdict with the payload scratchpad dir `dir` (default `D`; `null` = field absent). */
function v(command: string, dir: string | null = D): Verdict {
  const r = bashWriteGuard({ tool: "Bash", command, scratchpadDir: dir ?? undefined });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

describe("ampersand redirects proven inside the scratchpad get the `>` verdict", () => {
  test("&>, &>>, >&file and N> pass when every target is in the scratchpad", () => {
    for (const cmd of [`echo x &> ${D}/a`, `echo x &>> ${D}/a`, `echo x >& ${D}/a`, `echo x >&${D}/a`, `echo x &>${D}/a`, `echo x &> "${D}/a"`, `echo x &> '${D}/a'`, `echo x 2> ${D}/e &> ${D}/a`, `echo x &> ${D}/a 2>&1`, `echo x &> ${D}/a; echo y &>> ${D}/b`]) {
      expect(v(cmd), cmd).toBe("allow");
    }
  });
  test("$S targets obey the same binding proof as `>`", () => {
    expect(v(`S=${D}; echo x &> $S/a`)).toBe("allow");
    expect(v(`S=${D}; echo x >& \${S}/a`)).toBe("allow");
    expect(v(`echo x &> $S/a`)).toBe("ask");
    expect(v(`S=${P}; echo x &> $S/a`)).toBe("ask");
    expect(v(`echo x &> $S/a; S=${D}`)).toBe("ask");
  });
  test("a runner may own an ampersand redirect, but nothing may redirect after it", () => {
    expect(v(`bun test &> ${D}/a.log`)).toBe("allow");
    expect(v(`bun test &> ${D}/a.log; tail -3 ${D}/a.log`)).toBe("allow");
    expect(v(`bun test &> ${D}/a.log; echo x > ${D}/b`)).toBe("ask");
    expect(v(`bun test &> ${D}/a.log; echo x &> ${D}/b`)).toBe("ask");
  });
});

describe("anything not proven keeps the amp verdict", () => {
  test("project, sibling, depth-2 and traversal targets ask", () => {
    for (const cmd of [`echo x &> ${P}/b`, `echo x &>> ${P}/b`, `echo x >& ${P}/b`, `echo x &> ${D}/sub/a`, `echo x &> ${D}/../x`, `echo x &> ${D}x/a`]) {
      expect(v(cmd), cmd).toBe(askNow(cmd));
    }
  });
  test("one unsafe target among several asks, either order", () => {
    for (const cmd of [`echo x &> ${D}/a &> ${P}/b`, `echo x &> ${P}/b &> ${D}/a`, `echo x &> ${D}/a > ${P}/b`, `echo x > ${D}/a >& ${P}/b`]) {
      expect(v(cmd), cmd).toBe(askNow(cmd));
    }
  });
  test("zsh-only and malformed operators stay asks", () => {
    for (const cmd of [`echo x >>& ${D}/a`, `echo x >&| ${D}/a`, `echo x >&! ${D}/a`, `echo x &&> ${D}/a`, `echo x &>| ${D}/a`, `echo x &2> ${D}/a`]) {
      expect(v(cmd), cmd).toBe("ask");
    }
  });
  test("background jobs, unknown command words and process substitution stay asks", () => {
    expect(v(`echo x &> ${D}/a &`)).toBe("ask");
    expect(v(`echo x & > ${D}/a`)).toBe("ask");
    expect(v(`python3 t.py &> ${D}/a`)).toBe("ask");
    expect(v(`cmd &> ${D}/a`)).toBe("ask");
    expect(v(`cmd >(tee ${P}/b) &> ${D}/a`)).toBe("ask");
  });
  test("code-file targets stay a BLOCK, never relaxed", () => {
    expect(v(`echo x &> ${D}/x.ts`)).toBe("block");
    expect(v(`S=${D}; echo x >& $S/x.py`)).toBe("block");
  });
  test("no usable scratchpad_dir keeps the ask", () => {
    for (const bad of [null, "", "/tmp", `${D}/../..`]) expect(v(`echo x &> ${D}/a`, bad), String(bad)).toBe(askNow(`echo x &> ${D}/a`));
  });
  test("a symlink at the target keeps the ask", () => {
    symlinkSync(join(P, "f.txt"), join(D, "sym"));
    expect(v(`echo x &> ${D}/sym`)).toBe(askNow(`echo x &> ${D}/sym`));
    expect(v(`echo x >& ${D}/sym`)).toBe(askNow(`echo x >& ${D}/sym`));
  });
});

describe("the window never makes a command more permissive than without its redirects", () => {
  test("later ask-tier writers still ask", () => {
    expect(v(`echo x | tee ${P}/n.txt &> ${D}/b`)).toBe("ask");
    expect(v(`dd if=/dev/zero of=${P}/blob &> ${D}/b`)).toBe("ask");
  });
});

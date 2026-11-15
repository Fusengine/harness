import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-anyvar-")));
const D = join(root, "claude-501", "-proj", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", "scratchpad");
mkdirSync(D, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Verdict = "allow" | "ask" | "block";
function v(command: string): Verdict {
  const r = bashWriteGuard({ tool: "Bash", command, scratchpadDir: D });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

describe("any variable bound to the scratchpad in the same command is accepted", () => {
  test.each([
    `s=${D}; echo x > $s/x.txt`,
    `s=${D}; echo x > "$s/x.txt"`,
    `s=${D}; echo x > \${s}/x.txt`,
    `s=${D}; echo x >> $s/log.txt`,
    `s=${D}; echo x 2> $s/err.txt`,
    `s='${D}'; echo x > $s/x.txt`,
    `s="${D}/"; echo x > $s/x.txt`,
    `OUT=${D} && echo x > $OUT/x.txt`,
    `Pad=${D}; cat /etc/hosts | wc -l > $Pad/n.txt`,
    `s=${D}; echo x > $s/a.txt; wc -l $s/a.txt`,
  ])("%s", (cmd) => {
    expect(v(cmd)).toBe("allow");
  });
  test("the original `S` convention is unchanged", () => {
    expect(v(`S=${D}; echo x > $S/x.txt`)).toBe("allow");
    expect(v(`S=${D}; echo x > \${S}/x.txt`)).toBe("allow");
  });
});

describe("negative control: unknown or unproven variables keep asking", () => {
  test.each([
    `echo x > $s/x.txt`,
    `s=/etc; echo x > $s/x.txt`,
    `s=${D}/..; echo x > $s/x.txt`,
    `s=${D}; echo x > $t/x.txt`,
    `echo x > $s/x.txt; s=${D}`,
    `true || s=${D}; echo x > $s/x.txt`,
    `s=${D}; s=/etc; echo x > $s/x.txt`,
    `s=${D}; s+=/x; echo x > $s/x.txt`,
    `s=$HOME; echo x > $s/x.txt`,
    `s=$(pwd); echo x > $s/x.txt`,
    `s=${D}; echo x > '$s/x.txt'`,
    `s=${D}; echo x > $s/../x.txt`,
    `s=${D}; echo x > $s/sub/x.txt`,
    `s=${D}; echo x > /etc/passwd`,
    `s=${D}; echo x > ${root}/outside.txt`,
    `s=${D}; echo x > $s/x.txt; echo y > $S/y.txt`,
    `s=${D}; echo x > $s$s/x.txt`,
    `s=${D}; rm $s/x.txt; echo x > $s/x.txt`,
  ])("%s", (cmd) => {
    expect(v(cmd)).not.toBe("allow");
  });
  test("variables that steer the shell are never accepted, even bound to the scratchpad", () => {
    for (const name of ["PATH", "IFS", "HOME", "ENV", "SHELL", "CDPATH", "PS4", "BASH_ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PROMPT_COMMAND", "PYTHONPATH", "PERL5LIB", "RUBYLIB", "CLASSPATH"]) {
      expect(v(`${name}=${D}; echo x > $${name}/x.txt`), name).not.toBe("allow");
    }
  });
});

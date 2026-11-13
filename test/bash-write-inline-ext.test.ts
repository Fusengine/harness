import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import type { GuardContext } from "../src/policy/guards/context";
import { REAL_CWD } from "./helpers/real-cwd";

/**
 * Challenger-measured bypass #9 closures (2026-09-05) on top of
 * test/bash-write-inline-widen.test.ts's baseline: perl `-E` (uppercase
 * eval switch), node/bun glued short-option clusters (`-pe`), the
 * `fs`/`fs/promises` `open(...)` write-mode + FileHandle `.write(...)`
 * co-occurrence, the widened `CODE_EXT` list (`mts`/`cts`/`mjs`/`cjs`), and
 * case-insensitive `CODE_COMMAND_WRITE`/`CODE_REDIRECT`. Split into its own
 * file (parity bash-write-inline-widen.test.ts, already at its 89-line
 * ceiling) to stay under the 200-line SOLID ceiling.
 */

const cmd = (command: string): GuardContext => ({ tool: "Bash", command, cwd: REAL_CWD });

// Item 1: perl `-E` clusters the same way as `-e` (perlrun clustering rule).

test("perl -E writing a code file now blocks (was allow)", () => {
  const command = 'perl -E \'open(F,">","src/x.ts");print F 1\'';
  expect(bashWriteGuard(cmd(command))?.kind).toBe("block");
});

test("witness: perl -E with no write API still allows", () => {
  expect(bashWriteGuard(cmd("perl -E 'say 1'"))).toBeNull();
});

// Item 2: node/bun glued short-option cluster containing `e`/`p` (`-pe`).

test("node -pe writing a code file now blocks (was allow)", () => {
  const command = 'node -pe \'require("fs").writeFileSync("src/x.ts","1")\'';
  expect(bashWriteGuard(cmd(command))?.kind).toBe("block");
});

test("witness: node -pe with no write API still allows", () => {
  expect(bashWriteGuard(cmd("node -pe '1+1'"))).toBeNull();
});

test("witness: node -v (no e/p in cluster) never becomes an anchor", () => {
  expect(bashWriteGuard(cmd("node -v"))).toBeNull();
});

// Item 3: `fs`/`fs/promises` `open(...)` write mode + FileHandle `.write(...)`.

test("fs/promises open(...,'w') + FileHandle.write(...) on a code file blocks", () => {
  const command = "node -e '(async()=>{const fh=await (await import(\"node:fs/promises\"))"
    + ".open(\"src/x.ts\",\"w\");await fh.write(\"1\");})()'";
  expect(bashWriteGuard(cmd(command))?.kind).toBe("block");
});

test("open(...,'w') alone on a non-code file asks (never blocks)", () => {
  expect(bashWriteGuard(cmd("node -e 'open(\"x.json\",\"w\")'"))?.kind).toBe("ask");
});

test("witness: console.log(open) — no write-mode call, no write API — allows", () => {
  expect(bashWriteGuard(cmd("node -e 'console.log(open)'"))).toBeNull();
});

// Item 4: CODE_EXT gains mts/cts/mjs/cjs (explicit-module-kind extensions).

test("bun -e writeFileSync to a .mts file now blocks (was allow)", () => {
  const command = 'bun -e \'require("fs").writeFileSync("a.mts","1")\'';
  expect(bashWriteGuard(cmd(command))?.kind).toBe("block");
});

test("bun -e writeFileSync to a .cjs file now blocks (was allow)", () => {
  const command = 'bun -e \'require("fs").writeFileSync("a.cjs","1")\'';
  expect(bashWriteGuard(cmd(command))?.kind).toBe("block");
});

// Item 5: CODE_COMMAND_WRITE / CODE_REDIRECT are now case-insensitive.

test("tee to an upper-case .TS extension now blocks (was ask)", () => {
  expect(bashWriteGuard(cmd("tee src/a.TS"))?.kind).toBe("block");
});

test("redirect to an upper-case .TS extension blocks", () => {
  expect(bashWriteGuard(cmd("echo 1 > a.TS"))?.kind).toBe("block");
});

test("witness: redirect to a non-code upper-case extension is not a code block (ask; literal text -> block with the Write/Edit message)", () => {
  expect(bashWriteGuard(cmd("prog > a.TXT"))?.kind).toBe("ask");
  expect(bashWriteGuard(cmd("echo 1 > a.TXT"))?.title).toBe("Bash write of literal text");
});

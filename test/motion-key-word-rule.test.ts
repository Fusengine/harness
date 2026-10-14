import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEvent } from "../src/runtime/normalize";
import { motionKeyViolation } from "../src/policy/motion/guard-key";
import { motionKeyDirectory } from "../src/policy/motion/store";

const home = realpathSync(mkdtempSync(join(tmpdir(), "motion-keyword-")));
const keyDir = motionKeyDirectory(home);
mkdirSync(keyDir, { recursive: true });
const cwd = join(home, "work");
mkdirSync(cwd, { recursive: true });

/** Run the key guard for one tool call and return the verdict kind (null = allowed). */
const verdict = (tool: string, input: Record<string, unknown>): string | null =>
  motionKeyViolation(normalizeEvent("claude-code", { tool_name: tool, tool_input: input }), cwd, home)?.kind ?? null;
const bash = (command: string): string | null => verdict("Bash", { command });

test("ALLOW 1 ssh + python with lambda key= sort and slicing", () => {
  expect(bash(`ssh -o BatchMode=yes root@10.10.11.9 "python3 -c \\"import sqlite3,re; R=[r for r in rows]; print(sorted(kinds.items(),key=lambda x:-x[1])[:12])\\""`)).toBeNull();
});
test("ALLOW 2 python sort(key=lambda) with slicing", () => {
  expect(bash(`cd /tmp/x && python3 -c "out.sort(key=lambda r: r[0]); print(out[:5])"`)).toBeNull();
});
test("ALLOW 3 sqlite3 query selecting a key column", () => {
  expect(bash(`cd /tmp/x && sqlite3 -readonly g/state.vscdb "select count(*), substr(key,1,12) from cursorDiskKV where key like 'bubbleId:%'"`)).toBeNull();
});
test("ALLOW 4 python json keys() slicing", () => {
  expect(bash(`python3 -c "import json; d=json.load(open('a.json')); print(sorted(d.keys())[:60])"`)).toBeNull();
});

test("BLOCK 5 literal key file paths", () => {
  expect(bash("cat ~/.fuse-harness/motion-keys/x.key")).toBe("block");
  expect(bash(`cat ${join(keyDir, "x.key")}`)).toBe("block");
});
test("BLOCK 6 glob and variable paths to the harness directory", () => {
  for (const command of ["cat ~/.fuse-har*/motion*/*", "cat $HOME/.fuse-harness/*", "cat ~/.fuse-harness/m*/*", "ls ~/.fuse-harness/"]) {
    expect(bash(command)).toBe("block");
  }
});
test("BLOCK 7 variable indirection into the harness directory", () => {
  expect(bash("D=$HOME/.fuse-harness; cat $D/m*/*")).toBe("block");
});
test("BLOCK 8 Read, Grep and Glob tools", () => {
  expect(verdict("Read", { file_path: join(keyDir, "x.key") })).toBe("block");
  expect(verdict("Grep", { path: keyDir, pattern: "." })).toBe("block");
  expect(verdict("Glob", { pattern: join(home, ".fuse-harness/*") })).toBe("block");
});
test("BLOCK 9 recursive grep and rg over the harness directory", () => {
  expect(bash("grep -r foo ~/.fuse-harness")).toBe("block");
  expect(bash("rg foo ~/.fuse-harness/motion-keys")).toBe("block");
});

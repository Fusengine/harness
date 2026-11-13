import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";

/** Verdict of the Bash write guard for `command` run from payload cwd `cwd`. */
function verdict(command: string, cwd?: string): "allow" | "ask" | "block" {
  const r = bashWriteGuard({ tool: "Bash", command, cwd });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

let root = "";
let tmpLink = "";
const must = (cmd: string, args: string[]): void => {
  expect(spawnSync(cmd, args).status).toBe(0);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync("/tmp/fh-bwal-"));
  mkdirSync(join(root, "real"));
  mkdirSync(join(root, "real", "sub"));
  writeFileSync(join(root, "real", "MEMORY.md"), "- a\n");
  writeFileSync(join(root, "real", "notes.md"), "x\n");
  writeFileSync(join(root, "real", "orig.txt"), "x\n");
  linkSync(join(root, "real", "orig.txt"), join(root, "real", "hard.txt"));
  symlinkSync("/dev", join(root, "devdir"));
  symlinkSync("/dev/tty", join(root, "ttylink"));
  symlinkSync("/dev/stderr", join(root, "errlink"));
  symlinkSync("/dev/stderr", join(root, "real", "errlink"));
  symlinkSync(join(root, "real", "notes.md"), join(root, "real", "filelink"));
  symlinkSync(join(root, "real"), join(root, "realdir"));
  must("mkfifo", [join(root, "fifo")]);
  must("mkfifo", [join(root, "real", "fifo")]);
  tmpLink = `/tmp/fh-bwal-L-${process.pid}`;
  symlinkSync("/dev/tty", tmpLink);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpLink, { force: true });
});

describe("literal write block: allowlist (fresh name / regular file in a real non-/dev dir)", () => {
  test("fresh name and existing regular file block, relative via payload cwd", () => {
    const cwd = join(root, "real");
    for (const cmd of [
      "echo x > fresh.md",
      "echo x > notes.md",
      "printf 'a\\n' >> MEMORY.md",
      "tee fresh.txt <<< hi",
      "cat > fresh.md <<EOF\nhi\nEOF",
      "cat <<'E' > notes.md\n$HOME\nE",
      "echo x > ./fresh.md",
      "echo x > sub/fresh.md",
    ]) expect(verdict(cmd, cwd)).toBe("block");
  });

  test("absolute fresh name / regular file block with no payload cwd", () => {
    expect(verdict(`echo x > ${root}/real/fresh.md`)).toBe("block");
    expect(verdict(`echo x > ${root}/real/notes.md`)).toBe("block");
  });

  test("owner command: cd tmp && printf >> MEMORY.md && tail", () => {
    expect(verdict(`cd ${root}/real && printf '%s\\n' '- [a](b.md) — c' >> MEMORY.md && tail -2 MEMORY.md`)).toBe("block");
    expect(verdict(`cd ${root}/realdir && printf 'x\\n' >> MEMORY.md`)).toBe("block");
  });

  test("code files still block regardless of cwd", () => {
    expect(verdict("echo x > src/a.ts", join(root, "real"))).toBe("block");
    expect(verdict("echo x > src/a.ts")).toBe("block");
  });
});

describe("literal write: every non-ordinary target keeps ask", () => {
  const real = (): string => join(root, "real");
  test("symlink to a device, absolute (challenger: /tmp/L -> /dev/tty)", () => {
    expect(verdict(`echo hi > ${tmpLink}`)).toBe("ask");
    expect(verdict(`echo hi > ${root}/ttylink`)).toBe("ask");
    expect(verdict(`echo hi >> ${root}/ttylink`)).toBe("ask");
  });
  test("symlinked parent dir to /dev, absolute", () => {
    expect(verdict(`echo hi > ${root}/devdir/tty`)).toBe("ask");
    expect(verdict(`echo hi > ${root}/devdir/stderr`)).toBe("ask");
  });
  test("relative symlink to /dev/stderr, with payload cwd", () => {
    expect(verdict("echo hi > errlink", real())).toBe("ask");
    expect(verdict("tee errlink <<< hi", real())).toBe("ask");
    expect(verdict("echo hi > errlink", root)).toBe("ask");
  });
  test("relative through a symlinked dir", () => {
    expect(verdict("echo hi > devdir/tty", root)).toBe("ask");
  });
  test("payload cwd is /dev or a symlink to /dev", () => {
    expect(verdict("echo hi > tty", "/dev")).toBe("ask");
    expect(verdict("echo hi > stderr", "/dev")).toBe("ask");
    expect(verdict("echo hi > tty", join(root, "devdir"))).toBe("ask");
    expect(verdict("cd /nonexist; echo hi > tty", "/dev")).toBe("ask");
    expect(verdict("cd /nonexist && echo hi > tty", join(root, "devdir"))).toBe("ask");
  });
  test("cd into a symlinked /dev dir, absolute or via cd", () => {
    expect(verdict(`cd ${root}/devdir && echo a > tty`)).toBe("ask");
    expect(verdict(`cd ${root}/devdir; echo a > stderr`, real())).toBe("ask");
  });
  test("FIFO and symlink to a regular file", () => {
    expect(verdict(`echo hi > ${root}/fifo`)).toBe("ask");
    expect(verdict("echo hi > fifo", real())).toBe("ask");
    expect(verdict("echo hi > filelink", real())).toBe("ask");
  });
  test("hard-linked regular file", () => {
    expect(verdict("echo hi > hard.txt", real())).toBe("ask");
    expect(verdict("echo hi > orig.txt", real())).toBe("ask");
  });
  test("no payload cwd, relative target", () => {
    expect(verdict("echo hi > notes.md")).toBe("ask");
    expect(verdict("echo hi > fresh.md")).toBe("ask");
  });
  test("relative payload cwd, missing parent, directory, /dev/proc", () => {
    expect(verdict("echo hi > notes.md", "real")).toBe("ask");
    expect(verdict("echo hi > nodir/a.md", real())).toBe("ask");
    expect(verdict(`echo hi > ${root}/nodir/a.md`)).toBe("ask");
    expect(verdict("echo hi > sub", real())).toBe("ask");
    expect(verdict("echo hi > /dev/stderr")).toBe("ask");
    expect(verdict("echo hi > a.md", "/proc")).toBe("ask");
  });
  test("zsh =word expansion is not a file name", () => {
    for (const cmd of ["echo hi > =git", "echo hi >> =ls", "tee =cat <<< hi", "cat > =ls <<'E'\nx\nE", `cd ${root}/real && printf hi > =ls`]) {
      expect(verdict(cmd, real())).toBe("ask");
    }
    expect(verdict("echo hi > a=b.md", real())).toBe("block");
  });
  test("cd to a missing dir or to a file leaves the cwd unknown", () => {
    expect(verdict(`cd ${root}/nodir; echo hi > a.md`, real())).toBe("ask");
    expect(verdict(`cd ${root}/real/notes.md; echo hi > a.md`, real())).toBe("ask");
  });
});

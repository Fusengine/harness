import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityGuard } from "../src/policy/guards/security";
import { isTempOnlyDelete } from "../src/policy/guards/security-temp-delete";

/** Verdict of the security guard for one Bash command. */
const verdict = (command: string): string => securityGuard({ tool: "Bash", command })?.kind ?? "allow";

const FOLDERS = "/var/folders/ab/cd1234/T";

// Real Claude Code sets CLAUDE_PROJECT_DIR for hooks; the narrowing needs it (unset = main's verdict).
const savedProjectDir = process.env["CLAUDE_PROJECT_DIR"];
process.env["CLAUDE_PROJECT_DIR"] = process.cwd();
afterAll(() => {
  if (savedProjectDir === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
  else process.env["CLAUDE_PROJECT_DIR"] = savedProjectDir;
});

describe("CLAUDE_PROJECT_DIR gate (default project dirs)", () => {
  const withEnv = (value: string | undefined, fn: () => void): void => {
    const prev = process.env["CLAUDE_PROJECT_DIR"];
    if (value === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
    else process.env["CLAUDE_PROJECT_DIR"] = value;
    try {
      fn();
    } finally {
      process.env["CLAUDE_PROJECT_DIR"] = prev;
    }
  };
  test("unset -> block (main's verdict)", () => withEnv(undefined, () => expect(verdict("rm -rf /var/tmp/a")).toBe("block")));
  test("set to a temp dir -> block", () => {
    withEnv("/var/tmp/proj", () => expect(verdict("rm -rf /var/tmp/a")).toBe("block"));
    withEnv(`${FOLDERS}/proj`, () => expect(verdict("rm -rf /var/tmp/a")).toBe("block"));
  });
  test("set to a normal project, normal process cwd -> ask", () => withEnv("/work/proj", () => expect(verdict("rm -rf /var/tmp/a")).toBe("ask")));
});

describe("narrowed to ask: every target strictly inside a system temp dir", () => {
  test.each([
    `rm -rf ${FOLDERS}/fh-x`,
    "rm -r /private/var/tmp/chg3",
    "rm -rf /var/tmp/a /var/tmp/b/c",
    `rm -rf ${FOLDERS}/a /private${FOLDERS}/b`,
    "rm -rf /var/tmp/a/",
    "rm -fr /var/tmp/a",
    "rm -r -f /var/tmp/a",
    "rm -rf /var/tmp/trash",
  ])("%s -> ask", (cmd) => {
    expect(verdict(cmd)).toBe("ask");
  });
  test("trash exemption is exactly main's: lifted block still asks, untouched commands stay exempt", () => {
    expect(verdict("rm -i /var/tmp/trash")).toBe("allow");
    expect(verdict("rm -rf /var/tmp/trash")).toBe("ask");
    expect(verdict("rm -rf /var/log/trash")).toBe("block");
  });
  test("the ask names the rm confirmation, not the system-directory block", () => {
    const r = securityGuard({ tool: "Bash", command: "rm -rf /var/tmp/a" });
    expect(r?.reason).toContain("DELETE: 'rm'");
    expect(r?.reason).not.toContain("system directory");
  });
});

describe("still blocked", () => {
  test.each([
    "rm -rf /var/tmp",
    "rm -rf /var/tmp/",
    `rm -rf ${FOLDERS}`,
    `rm -rf ${FOLDERS}/`,
    "rm -rf /var/folders",
    "rm -rf /var/folders/ab",
    "rm -rf /var/folders/ab/cd1234",
    "rm -rf /var/log/x",
    "rm -rf /var",
    "rm -rf /etc/x",
    "rm -rf /usr/lib",
    "rm -rf /var/tmp/../etc",
    "rm -rf /var/tmp/a/../../log",
    "rm -rf /var/tmp/./a",
    "rm -rf /var/folders/../etc/T/x",
    "rm -rf /var/folders/ab/../T/x",
    "rm -rf /var/folders/./../T/x",
    "rm -rf /var/tmp//a",
    "rm -rf /var/tmp/*",
    "rm -rf /var/tmp/a?",
    "rm -rf /var/tmp/[ab]",
    "rm -rf /var/tmp/{a,b}",
    "rm -rf /var/tmp/$X",
    "rm -rf /var/tmp/${X}",
    "rm -rf /var/tmp/$(echo a)",
    "rm -rf /var/tmp/`echo a`",
    "rm -rf /var/tmp/~x",
    "rm -rf /var/tm\\p/a",
    "rm -rf /var/tmp/a /etc/x",
    "rm -rf /var/tmp/a /var/log/x",
    "rm -rf /var/tmp/a; rm -rf /usr/lib",
    "rm -rf /var/tmp/a && echo hi",
    "echo hi; rm -rf /var/tmp/a",
    "rm -rf /var/tmp/a | cat",
    "rm -rf /var/tmp/a > /dev/null",
    "sudo rm -rf /var/tmp/a",
    "rm -rf /var/tmp/a\nrm -rf /usr/lib",
    "rm -rf /var/tmp/a <<X\n$(rm -rf /usr)\nX",
    "rm -rf /var/tmp/a <<-X\n$(rm -rf /usr)\n\tX",
    "rm -rf /var/tmp/a <<'X'\nbody\nX",
    "rm -rf /var/tmp/a <<<$(rm -rf /usr)",
  ])("%s -> block", (cmd) => {
    expect(verdict(cmd)).toBe("block");
  });
});

describe("not matched by the system-directory block today: verdict unchanged (ask)", () => {
  test.each([
    "rm -rf /private/var/tmp",
    "rm -rf ~/x /var/tmp/a",
    "rm -rf '/var/tmp/a'",
    'rm -rf "/var/tmp/a"',
    "rm -rf --no-preserve-root /var/tmp/a",
    "rm -rf -- /var/tmp/a",
    "rm /var/tmp/a -rf",
  ])("%s -> ask", (cmd) => {
    expect(verdict(cmd)).toBe("ask");
  });
});

describe("symlinks and project root (real filesystem)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-tempdel-")));
  mkdirSync(join(base, "real", "sub"), { recursive: true });
  symlinkSync("/etc", join(base, "link"));
  symlinkSync(join(base, "real"), join(base, "dirlink"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  // The hook only knows /var/tmp and /var/folders; the filesystem-aware core takes an explicit root list for tests.
  const check = (cmd: string): boolean => isTempOnlyDelete(cmd, { roots: [base], projectDirs: [] });

  test("a plain existing dir and a missing leaf pass", () => {
    expect(check(`rm -rf ${base}/real/sub`)).toBe(true);
    expect(check(`rm -rf ${base}/real/sub/missing`)).toBe(true);
    expect(check(`rm -rf ${base}/missing/deeper`)).toBe(true);
  });
  test("a symlink leaf or a symlinked component is refused", () => {
    expect(check(`rm -rf ${base}/link`)).toBe(false);
    expect(check(`rm -rf ${base}/link/x`)).toBe(false);
    expect(check(`rm -rf ${base}/dirlink`)).toBe(false);
    expect(check(`rm -rf ${base}/dirlink/sub`)).toBe(false);
    expect(check(`rm -rf ${base}/real/sub ${base}/dirlink/sub`)).toBe(false);
  });
  test("a symlinked root level (T, x) is refused; a real-shaped tree passes", () => {
    mkdirSync(join(base, "x1", "y1", "T"), { recursive: true });
    mkdirSync(join(base, "xr", "y1", "T"), { recursive: true });
    symlinkSync(join(base, "xr"), join(base, "xl"));
    mkdirSync(join(base, "x2", "y1"), { recursive: true });
    symlinkSync(join(base, "x1", "y1", "T"), join(base, "x2", "y1", "T"));
    const at = (root: string): boolean => isTempOnlyDelete(`rm -rf ${root}/f`, { roots: [root], projectDirs: [] });
    expect(at(`${base}/x1/y1/T`)).toBe(true);
    expect(at(`${base}/xl/y1/T`)).toBe(false);
    expect(at(`${base}/x2/y1/T`)).toBe(false);
  });
  test("the root itself and anything outside the roots is refused", () => {
    expect(check(`rm -rf ${base}`)).toBe(false);
    expect(check(`rm -rf ${base}/`)).toBe(false);
    expect(check("rm -rf /etc/x")).toBe(false);
  });
  test("project root inside a temp dir disables the narrowing", () => {
    expect(isTempOnlyDelete(`rm -rf ${base}/real/sub`, { roots: [base], projectDirs: [join(base, "real")] })).toBe(false);
    expect(isTempOnlyDelete(`rm -rf ${base}/real/sub`, { roots: [base], projectDirs: ["/work/proj"] })).toBe(true);
  });
});

describe("default wiring", () => {
  test("project root outside any temp dir (this repo) narrows as specified", () => {
    expect(isTempOnlyDelete("rm -rf /var/tmp/a")).toBe(true);
    expect(isTempOnlyDelete("rm -rf /var/tmp")).toBe(false);
  });
});

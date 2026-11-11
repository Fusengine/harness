import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preCommitGate, type Exec } from "../src/runtime/precommit";
import { gitCommitDir } from "../src/runtime/git-commit-command";
import { dryGate } from "../src/runtime/dry";
import { releasePrompt } from "../src/runtime/release-gate/pre";
import type { NormalizedEvent } from "../src/runtime/normalize";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fo-"));
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "tsconfig.json"), "{}");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const fail = (props: Record<string, unknown>): Exec => () => { throw Object.assign(new Error("x"), props); };
const ok: Exec = () => "";

// --- precommit: failure paths -------------------------------------------------
test("missing linter binary: fail-open WITH a visible warning (inform, not silent)", () => {
  const p = preCommitGate("Bash", "git commit -m y", cwd, fail({ code: "ENOENT" }));
  expect(p?.kind).toBe("inform");
  expect(p?.reason).toContain("not installed");
  expect(p?.userMessage).toContain("TypeScript");
});

test("linter timeout: fail-open WITH a visible warning", () => {
  const p = preCommitGate("Bash", "git commit -m y", cwd, fail({ code: "ETIMEDOUT", signal: "SIGTERM" }));
  expect(p?.kind).toBe("inform");
  expect(p?.reason).toContain("timed out after 30s");
});

test("real lint findings (stdout) block; non-zero exit with empty stdout (bunx cannot find the tool) warns, never blocks", () => {
  const found = preCommitGate("Bash", "git commit -m y", cwd, fail({ status: 2, stdout: Buffer.from("src/a.ts: error"), stderr: Buffer.from("") }));
  expect(found?.kind).toBe("block");
  const noTool = preCommitGate("Bash", "git commit -m y", cwd, fail({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("error: could not find eslint") }));
  expect(noTool?.kind).toBe("inform");
  expect(noTool?.reason).toContain("could not find eslint");
  expect(preCommitGate("Bash", "git commit -m y", cwd, fail({ status: 1 }))?.kind).toBe("inform");
});

test("commit text inside a heredoc body is data; lint root never climbs past the repo top", () => {
  expect(blocks("cat > n.md <<'EOF'\ngit commit -m later\nEOF")).toBe(false);
  const repo = join(cwd, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // package.json lives ABOVE the repo (cwd): a plain commit inside the manifest-less repo lints nothing.
  expect(preCommitGate("Bash", "git commit -m y", repo, fail({ status: 1, stdout: Buffer.from("E") }))).toBeNull();
});

test("clean linters: null", () => {
  expect(preCommitGate("Bash", "git commit -m y", cwd, ok)).toBeNull();
});

// --- precommit: trigger behind wrappers ---------------------------------------
const blocks = (command: string): boolean => preCommitGate("Bash", command, cwd, fail({ status: 1, stdout: Buffer.from("E") }))?.kind === "block";

test("git commit behind cd / -C / env / subshell / group / sh -c is gated", () => {
  mkdirSync(join(cwd, "x"));
  for (const c of ["cd x && git commit -m y", "git -C x commit -m y", "FOO=1 git commit -m y", "(git commit -m y)", "{ git commit -m y; }", "sh -c 'git commit -m y'", "git add . && git commit -m y", "env GIT_X=1 git -c a=b commit -m y", "cd x; git commit -m y"]) {
    expect([c, blocks(c)]).toEqual([c, true]);
  }
});

test("no false positive: commit text inside quotes / other subcommands", () => {
  for (const c of ["echo 'git commit -m y'", 'echo "cd x && git commit"', "git log --grep=commit", "git status", "ls && echo commit", "git commit-tree HEAD"]) {
    expect([c, blocks(c)]).toEqual([c, c === "git log --grep=commit" || c === "git commit-tree HEAD"]);
  }
});

test("gitCommitDir follows cd and -C to the directory the commit runs in", () => {
  mkdirSync(join(cwd, "x"));
  expect(gitCommitDir("cd x && git commit -m y", cwd)).toBe(join(cwd, "x"));
  expect(gitCommitDir("git -C x commit -m y", cwd)).toBe(join(cwd, "x"));
  expect(gitCommitDir("cd $SOMEWHERE && git commit", cwd)).toBe(cwd);
  expect(gitCommitDir("git status", cwd)).toBeNull();
});

// --- DRY grep ------------------------------------------------------------------
const longDecl = "export function aVeryLongFunctionName() {}";
const grepFail = (props: Record<string, unknown>) => () => { throw Object.assign(new Error("x"), props); };

test("DRY grep timeout: fail-open with a visible warning", () => {
  const p = dryGate("Write", join(cwd, "a.ts"), longDecl, cwd, grepFail({ code: "ETIMEDOUT" }));
  expect(p?.kind).toBe("inform");
  expect(p?.reason).toContain("grep timed out");
});

test("DRY grep exit 1 = clean (silent); exit 2 keeps the matches it printed", () => {
  expect(dryGate("Write", join(cwd, "a.ts"), longDecl, cwd, grepFail({ status: 1 }))).toBeNull();
  const two = dryGate("Write", join(cwd, "a.ts"), longDecl, cwd, grepFail({ status: 2, stdout: "/p/one.ts\n/p/two.ts\n" }));
  expect(two?.kind).toBe("block");
});

// --- release gate --------------------------------------------------------------
const ev = (command: string): NormalizedEvent => ({ command, sessionId: "s", cwd } as unknown as NormalizedEvent);
const crash = (): never => { throw new Error("gate bug"); };

test("crashed release gate: a merge/tag-looking command is asked (fail-closed)", () => {
  for (const c of ["gh pr merge 12 --merge", "cd x && git tag -a v1 -m r", "gh -R o/r pr merge 3"]) {
    const p = releasePrompt(ev(c), { cwd } as never, crash);
    expect([c, p?.kind]).toEqual([c, "ask"]);
  }
});

test("crashed release gate: unrelated commands stay allowed", () => {
  for (const c of ["ls -la", "git commit -m y", "gh pr view 3", "bun test"]) {
    expect([c, releasePrompt(ev(c), { cwd } as never, crash)]).toEqual([c, null]);
  }
});

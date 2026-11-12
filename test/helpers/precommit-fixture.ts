import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Exec } from "../../src/runtime/precommit";

/**
 * Real fixture shared by the pre-commit gate tests: a repo (`main`, manifests but NO node_modules), a linked
 * worktree (`wt`, own node_modules) and a fake `bunx` that, like tsc with missing types, passes only where
 * node_modules exists. Every git call is sanitized (no repo-controlled config can run code).
 */
export interface PrecommitFixture { base: string; main: string; wt: string; fakeBin: string }

/** Run git with fsmonitor/hooks disabled and an isolated HOME. */
export function git(cwd: string, home: string, ...args: string[]): void {
  execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd, stdio: "ignore", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

/** Create the fixture under a fresh temp dir. */
export function setupFixture(): PrecommitFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pcwt-")));
  const main = join(base, "main");
  const wt = join(base, "wt");
  mkdirSync(main);
  git(main, base, "init", "-q", "-b", "trunk");
  writeFileSync(join(main, "package.json"), "{}");
  writeFileSync(join(main, "tsconfig.json"), "{}");
  git(main, base, "add", ".");
  git(main, base, "commit", "-q", "-m", "init");
  git(main, base, "worktree", "add", "-q", wt, "-b", "side");
  mkdirSync(join(wt, "node_modules"));
  mkdirSync(join(wt, "src"));
  mkdirSync(join(main, "x"));
  const fakeBin = join(base, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "bunx"), '#!/bin/sh\nif [ -d node_modules ]; then exit 0; fi\necho "error TS2688: Cannot find type definition file"\nexit 2\n');
  chmodSync(join(fakeBin, "bunx"), 0o755);
  return { base, main, wt, fakeBin };
}

/** Remove the fixture. */
export function teardownFixture(fx: PrecommitFixture): void {
  rmSync(fx.base, { recursive: true, force: true });
}

/** Records the cwd of every linter spawn; fails like tsc when `node_modules` is missing there. */
export function spy(): { exec: Exec; cwds: string[] } {
  const cwds: string[] = [];
  const exec: Exec = (_f, _a, o) => {
    cwds.push(o.cwd);
    if (!execFileSync("ls", { cwd: o.cwd }).toString().includes("node_modules")) throw Object.assign(new Error("x"), { status: 2, stdout: Buffer.from("TS2688") });
    return "";
  };
  return { exec, cwds };
}

/**
 * `harness prd init` CLI tests: bootstrap of the PRD router (the lead cannot
 * Write `.claude/apex/prd.json` itself — protectedPathGuard blocks it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPrdInit } from "../../src/cli/prd/init";
import { runPrd } from "../../src/cli/prd";
import { runPrdStatus } from "../../src/cli/prd/status";
import { prdRouterPath } from "../../src/policy/prd/prd-paths";
import { capture, tmpRoot } from "./prd-fixtures";

const roots: string[] = [];

// HOME is isolated on the command line (`HOME=$(mktemp -d) bun test ...`): Bun caches
// os.homedir(), so assigning process.env.HOME here would not keep loadDotenv off the real ~/.claude/.env.

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = tmpRoot();
  roots.push(dir);
  return dir;
}

const PRD_ON = { FUSE_PRD: "1" };
const routerOf = (r0: string): string => prdRouterPath(r0, ".claude");
const readRouter = (r0: string): unknown => JSON.parse(readFileSync(routerOf(r0), "utf8"));

function seedRouter(r0: string, text: string): void {
  mkdirSync(join(r0, ".claude", "apex"), { recursive: true });
  writeFileSync(routerOf(r0), text);
}

describe("harness prd init", () => {
  test("init-creates-empty-router", async () => {
    const r0 = root();
    const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code"], r0, PRD_ON));
    expect(r.code).toBe(0);
    expect(readRouter(r0)).toEqual({});
  });

  test("init-task-registers-entry", async () => {
    const r0 = root();
    const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", "auth-refactor"], r0, PRD_ON));
    expect(r.code).toBe(0);
    expect(readRouter(r0)).toEqual({ "auth-refactor": { prd: "prd/auth-refactor-prd.json", status: "assigned" } });
  });

  test("init-requires-fuse-prd-exit1", async () => {
    const r0 = root();
    const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code"], r0, {}));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("FUSE_PRD=1");
    expect(existsSync(routerOf(r0))).toBe(false);
  });

  test("init-existing-valid-router-unchanged-exit0", async () => {
    const r0 = root();
    const original = JSON.stringify({ t1: { prd: "prd/t1-prd.json", status: "in-progress" } });
    seedRouter(r0, original);
    const noTask = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code"], r0, PRD_ON));
    const sameTask = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", "t1"], r0, PRD_ON));
    expect([noTask.code, sameTask.code]).toEqual([0, 0]);
    expect(readFileSync(routerOf(r0), "utf8")).toBe(original);
  });

  test("init-existing-router-missing-task-exit1", async () => {
    const r0 = root();
    const original = JSON.stringify({ t1: { prd: "prd/t1-prd.json", status: "assigned" } });
    seedRouter(r0, original);
    const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", "t2"], r0, PRD_ON));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("t2");
    expect(readFileSync(routerOf(r0), "utf8")).toBe(original);
  });

  test("init-malformed-router-never-clobbered", async () => {
    for (const bad of ["{not json", JSON.stringify({ t: { prd: 1, status: "assigned" } }), "[]"]) {
      const r0 = root();
      seedRouter(r0, bad);
      const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", "t"], r0, PRD_ON));
      expect(r.code).toBe(1);
      expect(readFileSync(routerOf(r0), "utf8")).toBe(bad);
    }
  });

  test("init-rejects-bad-task-id", async () => {
    for (const bad of ["../x", "a/b", "", "-x", ".hidden", "a".repeat(65)]) {
      const r0 = root();
      const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", bad], r0, PRD_ON));
      expect(r.code).toBe(2);
      expect(existsSync(routerOf(r0))).toBe(false);
    }
    const r0 = root();
    const missing = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task"], r0, PRD_ON));
    expect(missing.code).toBe(2);
  });

  test("init-inherited-property-task-name-not-treated-as-present", async () => {
    const r0 = root();
    seedRouter(r0, "{}");
    const r = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task", "constructor"], r0, PRD_ON));
    expect(r.code).toBe(1);
    expect(readFileSync(routerOf(r0), "utf8")).toBe("{}");
  });

  test("init-task-equals-form-rejected-and-unwritable-home-exit1", async () => {
    const r0 = root();
    expect((await capture(() => runPrdInit(["--root", r0, "--id", "claude-code", "--task=foo"], r0, PRD_ON))).code).toBe(2);
    expect(existsSync(routerOf(r0))).toBe(false);
    writeFileSync(join(r0, ".claude"), "not a dir"); // ENOTDIR when creating <root>/.claude/apex
    expect((await capture(() => runPrdInit(["--root", r0, "--id", "claude-code"], r0, PRD_ON))).code).toBe(1);
  });

  test("init-id-autodetect-sole-home-dir", async () => {
    const r0 = root();
    mkdirSync(join(r0, ".claude"), { recursive: true });
    const r = await capture(() => runPrdInit(["--root", r0], r0, PRD_ON));
    expect(r.code).toBe(0);
    expect(readRouter(r0)).toEqual({});

    const none = root();
    expect((await capture(() => runPrdInit(["--root", none], none, PRD_ON))).code).toBe(2);
    const several = root();
    mkdirSync(join(several, ".claude"), { recursive: true });
    mkdirSync(join(several, ".codex"), { recursive: true });
    const amb = await capture(() => runPrdInit(["--root", several], several, PRD_ON));
    expect(amb.code).toBe(2);
    expect(amb.stderr).toContain("--id");
    expect(existsSync(routerOf(several))).toBe(false);
  });

  test("init-double-run-single-writer", async () => {
    const r0 = root();
    const args = ["--root", r0, "--id", "claude-code", "--task", "t"];
    const runs = await Promise.all([1, 2, 3, 4].map(() => capture(() => runPrdInit(args, r0, PRD_ON))));
    expect(runs.every((r) => r.code === 0)).toBe(true);
    expect(readRouter(r0)).toEqual({ t: { prd: "prd/t-prd.json", status: "assigned" } });
  });

  test("dispatch: runPrd routes init; usage lists init", async () => {
    const r0 = root();
    expect((await capture(() => runPrd(["init", "--root", r0, "--id", "claude-code"], r0, PRD_ON))).code).toBe(0);
    const unknown = await capture(() => runPrd(["nope"], r0, PRD_ON));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("status|validate|compact|init");
  });

  test("status resolution unchanged: no router and no --id still exits 2 even with a home dir", async () => {
    const r0 = root();
    mkdirSync(join(r0, ".claude"), { recursive: true });
    expect((await capture(() => runPrdStatus(["--root", r0], r0, PRD_ON))).code).toBe(2);
  });
});

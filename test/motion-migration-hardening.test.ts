import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantingMotionKey, readMotionKey } from "../src/policy/motion/auth-key";
import { migrateMotionData, resetMotionMigrationMemo } from "../src/policy/motion/migrate";
import { MotionStoreError } from "../src/policy/motion/trust";
import { loadBannedTerms } from "../src/policy/motion/sensitive";
import { motionHome, motionLeftoverKeyNotice } from "../src/policy/motion/store";
import { bash, isDeny, makeFixture, run } from "./motion-handle-fixture";

/** Hardening of the 0.1.112 Motion migration: key-dir trust, Motion-scoped failures, downgrade, banned union, root symlink. */
const made: string[] = [];
const fresh = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "motion-mh-"))); made.push(dir); return dir; };
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const harness = (home: string): string => join(home, ".fuse-harness");
const vm = (home: string): string => join(harness(home), "video-motion");

/** Home whose `video-motion/keys` is a symlink to a directory outside the home. */
function plantedKeys(): { home: string; outside: string } {
  const home = fresh(), outside = fresh();
  mkdirSync(vm(home), { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(vm(home), "keys"));
  return { home, outside };
}

/** Home in the downgrade/re-upgrade state: both layouts hold a `p.key` with different bytes. */
function conflictHome(): string {
  const home = fresh();
  mkdirSync(join(harness(home), "motion-keys"), { recursive: true, mode: 0o700 });
  mkdirSync(join(vm(home), "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(harness(home), "motion-keys/p.key"), "OLDKEY", { mode: 0o600 });
  writeFileSync(join(vm(home), "keys/p.key"), "NEWKEY", { mode: 0o600 });
  return home;
}

test("1: a symlinked video-motion/keys is refused with an explicit reason and never written through", () => {
  const { home, outside } = plantedKeys();
  resetMotionMigrationMemo();
  expect(() => migrateMotionData(home)).toThrow(MotionStoreError);
  expect(() => migrateMotionData(home)).toThrow(/key directory.*symlink/);
  expect(() => grantingMotionKey(join(home, "proj"), home)).toThrow(MotionStoreError);
  expect(readdirSync(outside)).toEqual([]);
  expect(() => readMotionKey(join(home, "proj"), home)).toThrow(MotionStoreError);
});

test("1: motion/keys carried along by the rename is caught after the migration", () => {
  const home = fresh(), outside = fresh();
  mkdirSync(join(harness(home), "motion"), { recursive: true });
  symlinkSync(outside, join(harness(home), "motion/keys"));
  resetMotionMigrationMemo();
  expect(() => migrateMotionData(home)).toThrow(/key directory.*symlink/);
  expect(readdirSync(outside)).toEqual([]);
});

test("1: a loose keys directory is tightened to 0700 and an existing key must not be a symlink", () => {
  const home = fresh();
  mkdirSync(join(vm(home), "keys"), { recursive: true });
  chmodSync(join(vm(home), "keys"), 0o755);
  resetMotionMigrationMemo();
  const key = grantingMotionKey(join(home, "proj"), home);
  expect(key?.length).toBe(32);
  expect(statSync(join(vm(home), "keys")).mode & 0o077).toBe(0);

  const other = fresh(), target = join(fresh(), "t.key");
  writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 });
  mkdirSync(join(vm(other), "keys"), { recursive: true, mode: 0o700 });
  const file = join(vm(other), "keys", readdirSync(join(vm(home), "keys"))[0]!);
  symlinkSync(target, file);
  expect(readMotionKey(join(home, "proj"), other)).toBeNull();
});

test("2: a store failure never blocks a call outside Motion, but blocks Motion work with the real cause and path", async () => {
  const fx = makeFixture();
  const outside = fresh();
  mkdirSync(vm(fx.home), { recursive: true, mode: 0o700 });
  symlinkSync(fresh(), join(vm(fx.home), "keys"));
  expect(await run(fx, bash("s1", "ls"), "motion", outside)).toBe("");
  expect(await run(fx, { hook_event_name: "Stop", session_id: "s1" }, "motion", outside)).toBe("");
  const inside = await run(fx, bash("s2", "ls", { tool_use_id: "tu-2" }));
  expect(isDeny(inside)).toBe(true);
  expect(inside).toContain(join(vm(fx.home), "keys"));
  expect(inside).toMatch(/symlink/);
  const touching = await run(fx, bash("s3", `cat ${join(vm(fx.home), "banned.txt")}`), "motion", outside);
  expect(isDeny(touching)).toBe(true);
});

test("2: a symlinked video-motion root and an unwritable harness dir are scoped to Motion too", async () => {
  const fx = makeFixture();
  const outside = fresh();
  mkdirSync(harness(fx.home), { recursive: true });
  symlinkSync(fresh(), vm(fx.home));
  expect(await run(fx, bash("s1", "ls"), "motion", outside)).toBe("");
  const inside = await run(fx, bash("s2", "ls"));
  expect(isDeny(inside)).toBe(true);
  expect(inside).toContain(vm(fx.home));

  const ro = makeFixture();
  mkdirSync(join(harness(ro.home), "motion/k"), { recursive: true });
  chmodSync(harness(ro.home), 0o500);
  try {
    expect(await run(ro, bash("s3", "ls"), "motion", outside)).toBe("");
  } finally { chmodSync(harness(ro.home), 0o700); }
});

test("3: differing keys in both layouts never lock out; the new directory stays authoritative and the old one untouched", async () => {
  const home = conflictHome();
  resetMotionMigrationMemo();
  expect(() => motionHome(home)).not.toThrow();
  expect(readFileSync(join(vm(home), "keys/p.key"), "utf8")).toBe("NEWKEY");
  expect(readFileSync(join(harness(home), "motion-keys/p.key"), "utf8")).toBe("OLDKEY");
  const notice = motionLeftoverKeyNotice(home);
  expect(notice).toContain(join(harness(home), "motion-keys"));
  expect(notice).toMatch(/leftover/);
  expect(notice).not.toMatch(/\n/);
});

test("3: the leftover notice shows in Motion context only", async () => {
  const fx = makeFixture();
  mkdirSync(join(harness(fx.home), "motion-keys"), { recursive: true, mode: 0o700 });
  mkdirSync(join(vm(fx.home), "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(harness(fx.home), "motion-keys/p.key"), "OLD", { mode: 0o600 });
  writeFileSync(join(vm(fx.home), "keys/p.key"), "NEW", { mode: 0o600 });
  const outside = fresh();
  expect(await run(fx, bash("s1", "ls"), "motion", outside)).toBe("");
  const inside = await run(fx, { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "hello" });
  expect(inside).toContain("leftover");
  expect(inside).toContain(join(harness(fx.home), "motion-keys"));
});

test("4: banned terms are the union of both layouts until the old file is gone", () => {
  const home = fresh();
  mkdirSync(join(harness(home), "motion"), { recursive: true });
  mkdirSync(vm(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(harness(home), "motion/banned.txt"), "acme\nshared\n");
  writeFileSync(join(vm(home), "banned.txt"), "# c\nmine\nshared\n");
  resetMotionMigrationMemo();
  expect(loadBannedTerms(home).sort()).toEqual(["acme", "mine", "shared"]);
  rmSync(join(harness(home), "motion/banned.txt"));
  expect(loadBannedTerms(home).sort()).toEqual(["mine", "shared"]);
});

test("5: a symlinked ~/.fuse-harness inside the home keeps working; outside the home it fails closed", () => {
  const inside = fresh();
  mkdirSync(join(inside, "real"), { recursive: true });
  symlinkSync(join(inside, "real"), harness(inside));
  resetMotionMigrationMemo();
  expect(() => motionHome(inside)).not.toThrow();

  const away = fresh(), home = fresh();
  symlinkSync(away, harness(home));
  resetMotionMigrationMemo();
  expect(() => motionHome(home)).toThrow(MotionStoreError);
  expect(() => motionHome(home)).toThrow(/outside the home/);
});

test("real CLI: a planted keys symlink does not block a Bash call outside any Motion project", () => {
  const home = fresh(), cwd = fresh();
  mkdirSync(vm(home), { recursive: true, mode: 0o700 });
  symlinkSync(fresh(), join(vm(home), "keys"));
  const bin = join(import.meta.dir, "..", "src", "cli", "bin.ts");
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cli1", tool_name: "Bash", tool_use_id: "tu-cli", tool_input: { command: "ls" }, cwd });
  const out = spawnSync(process.execPath, [bin, "hook", "claude-code", "motion"], { input: payload, cwd, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20000 });
  expect(out.status).toBe(0);
  expect(out.stdout).not.toContain("deny");
  expect(existsSync(join(home, ".fuse-harness/video-motion/keys"))).toBe(true);
}, 25000);

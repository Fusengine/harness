import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { grantingMotionKey, readMotionKey } from "../src/policy/motion/auth-key";
import { closeRender, loadBudget, openRender, releaseRender } from "../src/policy/motion/budget";
import { findPendingRoots, listApprovals, listPending, recordPending } from "../src/policy/motion/approvals";
import { validMotionApproval } from "../src/policy/motion/auth-approval";
import { motionKeyPath, projectStoreDir, sessionStateFile, writeJsonObject } from "../src/policy/motion/store";
import { activeCritics, addActiveCritic, clearSessionCritics, purgeMotionSessions } from "../src/policy/motion/critic-flag";

const fixture = (): { root: string; home: string } => ({ root: mkdtempSync(join(tmpdir(), "motion4-root-")), home: mkdtempSync(join(tmpdir(), "motion4-home-")) });

test("parent session end clears missing critic-stop bookkeeping and preserves other fields", () => {
  const { home } = fixture(), file = sessionStateFile("session", home)!;
  writeJsonObject(file, { other: 1 });
  addActiveCritic("session", "critic", home);
  clearSessionCritics("session", home);
  expect(activeCritics("session", home)).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8")).other).toBe(1);
});

test("stale-session purge excludes symlinks and preserves refreshed current sessions", () => {
  const { home, root } = fixture(), old = new Date(Date.now() - 8 * 86400000);
  const stale = sessionStateFile("old", home)!, current = sessionStateFile("current", home)!, linked = sessionStateFile("linked", home)!;
  writeJsonObject(stale, { critics: [] }); utimesSync(stale, old, old);
  writeJsonObject(current, { critics: ["alive"] }); utimesSync(current, old, old);
  const target = join(root, "user.json"); writeFileSync(target, "user"); utimesSync(target, old, old); symlinkSync(target, linked);
  expect(activeCritics("current", home)).toEqual(["alive"]);
  purgeMotionSessions(home);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(current)).toBe(true);
  expect(existsSync(linked)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("user");
});

test("private key publication ignores restrictive umask", () => {
  const { root, home } = fixture();
  mkdirSync(join(home, ".fuse-harness", "motion-keys"), { recursive: true });
  const old = process.umask(0o777);
  try {
    mkdirSync(join(home, ".fuse-harness", "motion-keys"), { recursive: true });
    chmodSync(join(home, ".fuse-harness"), 0o700);
    chmodSync(join(home, ".fuse-harness", "motion-keys"), 0o700);
    expect(grantingMotionKey(root, home)).not.toBeNull();
    expect(statSync(motionKeyPath(root, home)).mode & 0o777).toBe(0o600);
    expect(readMotionKey(root, home)).not.toBeNull();
  } finally { process.umask(old); }
});

test("matching failure releases cap without counting; a fresh reservation never expires early", () => {
  const { root, home } = fixture(), env = { FUSE_MOTION_MAX_MASTER_RENDERS: "1" };
  expect(openRender(root, "one", "master", 1, home, env)).toBeNull();
  expect(openRender(root, "two", "master", 1 + 1_800_000, home, env)?.kind).toBe("block"); // age == TTL: still fresh
  expect(releaseRender(root, "wrong", home).inflight.one).toBeDefined();
  expect(releaseRender(root, "one", home)).toEqual({ renders: {}, wallMs: {}, inflight: {} });
  expect(openRender(root, "two", "master", 1e15, home, env)).toBeNull();
  closeRender(root, "two", "master", 1e15 + 1, home);
  expect(loadBudget(root, home).renders.master).toBe(1);
});

test("pending project discovery is session-bound and root-bound", () => {
  const { root, home } = fixture();
  recordPending(root, { stage: "stills", artifact: join(root, "contact.png"), sha256: "a".repeat(64), code: "abcd", createdAt: 1, sessionId: "one" }, home);
  expect(findPendingRoots("one", home)).toEqual([root]);
  expect(findPendingRoots("two", home)).toEqual([]);
  const file = join(projectStoreDir(root, home), "pending.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...raw, root: `${root}-forged` }));
  expect(findPendingRoots("one", home)).toEqual([]);
});

test("concurrent first grants preserve all pending and approvals and share one complete key", async () => {
  const { root, home } = fixture(), approvalsModule = resolve("src/policy/motion/approvals.ts");
  const barrier = join(home, "start");
  const workers = Array.from({ length: 8 }, (_, i) => {
    const child = spawn(process.execPath, ["--eval", `import {recordPending,grantPending} from ${JSON.stringify(approvalsModule)};
      import {existsSync,writeFileSync} from 'node:fs';
      const root=${JSON.stringify(root)},home=${JSON.stringify(home)},id='s${i}';
      writeFileSync(home+'/ready-${i}','');const deadline=Date.now()+10000;
      while(!existsSync(${JSON.stringify(barrier)})){if(Date.now()>deadline)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}
      recordPending(root,{stage:'stills',artifact:root+'/contact.png',sha256:'a'.repeat(64),code:'abcd',sessionId:id,createdAt:1},home);
      if(!grantPending(root,id,'stills','abcd','a'.repeat(64),2,home))process.exit(3);`], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    const result = new Promise<void>((resolveResult, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("grant worker timeout")); }, 12000);
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("exit", (code) => { clearTimeout(timeout); code === 0 ? resolveResult() : reject(new Error(`${code}: ${errors}`)); });
    });
    return { child, result };
  });
  try {
    const deadline = Date.now() + 10000;
    while (!workers.every((_, i) => existsSync(join(home, `ready-${i}`)))) {
      if (Date.now() > deadline) throw new Error("grant workers not ready");
      await new Promise<void>((done) => setTimeout(done, 5));
    }
    writeFileSync(barrier, "");
    await Promise.all(workers.map((worker) => worker.result));
    expect(listPending(root, home)).toEqual([]);
    expect(listApprovals(root, home)).toHaveLength(8);
    expect(listApprovals(root, home).every((a) => validMotionApproval(root, a, "stills", "a".repeat(64), join(root, "contact.png"), home))).toBe(true);
    expect(readMotionKey(root, home)?.length).toBe(32);
  } finally { for (const { child } of workers) if (child.exitCode === null) child.kill("SIGKILL"); }
}, 15000);

test("completion never repairs corrupt persisted budget", () => {
  const { root, home } = fixture(), dir = projectStoreDir(root, home);
  mkdirSync(dir, { recursive: true });
  for (const raw of ["{bad", "{}", '{"renders":{"master":"2"},"wallMs":{},"inflight":{}}']) {
    writeFileSync(join(dir, "budget.json"), raw);
    expect(() => closeRender(root, "one", "master", 5, home)).toThrow("corrupt");
    expect(readFileSync(join(dir, "budget.json"), "utf8")).toBe(raw);
  }
});

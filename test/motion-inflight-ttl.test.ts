import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { MAX_MASTER_ENV, RENDER_TTL_ENV, loadBudget, openRender, pruneInflight, releaseRender, releaseSessionRenders, renderTtlMs } from "../src/policy/motion/budget";
import { bash, isDeny, makeFixture } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";

const STILLS = "bash render.sh --stage stills";
const T0 = 1_000_000;
const DEFAULT_TTL = 1_800_000;

const fixture = (): { root: string; home: string } => ({
  root: realpathSync(mkdtempSync(join(tmpdir(), "motion-ttl-root-"))),
  home: realpathSync(mkdtempSync(join(tmpdir(), "motion-ttl-home-"))),
});

/** Run one claude-code hook payload with an injected clock and home. */
async function runAt(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  const out = await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" });
  return out.stdout;
}

/** The single project budget file created under a home (unit fixtures and hook fixtures alike). */
function budgetFile(home: string): string {
  const motion = join(home, ".fuse-harness", "video-motion");
  const dir = readdirSync(motion).find((entry) => /^[0-9a-f]{16}$/.test(entry));
  if (!dir) throw new Error("no project store under " + motion);
  return join(motion, dir, "budget.json");
}

test("leaked reservation: 2nd pre blocked while fresh, allowed once older than the TTL", async () => {
  const fx = makeFixture();
  const first = await runAt(fx, bash("s1", STILLS), T0);
  expect(isDeny(first)).toBe(false);
  expect(first).toContain("Motion render");
  const fresh = await runAt(fx, bash("s2", STILLS), T0 + 1_000);
  expect(isDeny(fresh)).toBe(true);
  expect(fresh).toContain("Motion concurrent render");
  const expired = await runAt(fx, bash("s3", STILLS), T0 + DEFAULT_TTL + 1);
  expect(isDeny(expired)).toBe(false);
  expect(expired).toContain("Motion render");
});

test("pre then Stop of the same session then pre: still blocked, allowed once past the TTL", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "Stop", session_id: "s1" }, T0 + 100);
  const blocked = await runAt(fx, bash("s2", STILLS), T0 + 200);
  expect(isDeny(blocked)).toBe(true); // pass 8: the main Stop releases nothing on any host
  expect(blocked).toContain("Motion concurrent render");
  expect(isDeny(await runAt(fx, bash("s2", STILLS), T0 + DEFAULT_TTL + 1))).toBe(false); // the TTL is the backstop
});

test("a fresh reservation from another session still blocks the stage", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS), T0))).toBe(false);
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 60_000);
  expect(isDeny(denied)).toBe(true);
  expect(denied).toContain("Motion concurrent render");
});

test("hook-level corrupt budget stays fail-closed and byte-identical", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS), T0))).toBe(false);
  const path = budgetFile(fx.home);
  writeFileSync(path, '{"renders":{"master":"2"},"wallMs":{},"inflight":{}}');
  const before = readFileSync(path, "utf8");
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 1_000);
  expect(isDeny(denied)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("master cap counts fresh inflight, ignores and purges stale ones", () => {
  const { root, home } = fixture();
  const env = { [MAX_MASTER_ENV]: "2" };
  expect(openRender(root, "m1", "master", T0, home, env)).toBeNull();
  expect(openRender(root, "m2", "master", T0 + 1, home, env)).toBeNull();
  expect(openRender(root, "m3", "master", T0 + 2, home, env)?.kind).toBe("block");
  expect(openRender(root, "m4", "master", T0 + DEFAULT_TTL + 2, home, env)).toBeNull();
  expect(Object.keys(loadBudget(root, home).inflight)).toEqual(["m4"]);
});

test("renderTtlMs: default 30 min, custom env respected, invalid values fall back", () => {
  expect(renderTtlMs({})).toBe(DEFAULT_TTL);
  expect(renderTtlMs({ [RENDER_TTL_ENV]: "5000" })).toBe(5000);
  for (const v of ["0", "abc", "-2", "1.5", "", undefined]) expect(renderTtlMs({ [RENDER_TTL_ENV]: v })).toBe(DEFAULT_TTL);
  const { root, home } = fixture();
  expect(openRender(root, "x", "stills", T0, home, { [RENDER_TTL_ENV]: "5000" })).toBeNull();
  expect(openRender(root, "x", "stills", T0 + 4_999, home, { [RENDER_TTL_ENV]: "5000" })?.kind).toBe("block");
  // Past the TTL the expired reservation no longer blocks a NEW id; re-opening the SAME id
  // stays refused (it lives in the retained expired map — motion-stop-subagent pins that).
  expect(openRender(root, "y", "stills", T0 + 5_001, home, { [RENDER_TTL_ENV]: "5000" })).toBeNull();
});

test("0.1.103-format inflight entries (no sessionId): stale purged, fresh kept, never corrupt", () => {
  const { root, home } = fixture();
  const legacy = JSON.stringify({ renders: {}, wallMs: {}, inflight: { old: { stage: "stills", ts: T0 } } });
  openRender(root, "seed", "stills", T0, home); // creates the store
  releaseRender(root, "seed", home);
  const file = budgetFile(home);
  writeFileSync(file, legacy);
  expect(pruneInflight(root, T0 + 1_000, home)).toEqual({ old: { stage: "stills", ts: T0 } });
  expect(openRender(root, "next", "stills", T0 + 2_000, home)).toBeNull(); // legacy entry is valid, not corrupt
  writeFileSync(file, legacy);
  expect(pruneInflight(root, T0 + DEFAULT_TTL + 1, home)).toEqual({});
  expect(loadBudget(root, home).inflight).toEqual({}); // purge persisted
});

test("releaseSessionRenders drops only that sub-agent's fresh entries", () => {
  const { root, home } = fixture();
  openRender(root, "a1", "stills", 1, home, {}, "sess-a", "agent-a");
  openRender(root, "a2", "stills", 2, home, {}, "sess-a");
  openRender(root, "b1", "draft", 3, home, {}, "sess-b", "agent-a");
  releaseSessionRenders(root, "sess-a", home, "agent-a");
  expect(Object.keys(loadBudget(root, home).inflight)).toEqual(["a2", "b1"]); // same session without agentId / same agentId in another session survive
  releaseSessionRenders(root, "sess-a", home, "ghost");
  expect(Object.keys(loadBudget(root, home).inflight)).toEqual(["a2", "b1"]);
});

test("releaseSessionRenders never touches the retained expired entries", () => {
  const { root, home } = fixture();
  openRender(root, "z1", "stills", 1, home, {}, "sess-a", "agent-z");
  pruneInflight(root, 1 + DEFAULT_TTL + 1, home); // z1 moves to the retained expired map
  expect(loadBudget(root, home).expired?.["z1"]).toBeDefined();
  releaseSessionRenders(root, "sess-a", home, "agent-z");
  const budget = loadBudget(root, home);
  expect(budget.inflight).toEqual({});
  expect(budget.expired?.["z1"]).toBeDefined(); // expired entries stay settleable — release is fresh-only
});

test("legacy id-less entries survive releaseSessionRenders and fall only by TTL", () => {
  const { root, home } = fixture();
  openRender(root, "seed", "stills", T0, home);
  releaseRender(root, "seed", home);
  const file = budgetFile(home);
  writeFileSync(file, JSON.stringify({ renders: {}, wallMs: {}, inflight: { old: { stage: "stills", ts: T0 } } }));
  releaseSessionRenders(root, "sess-a", home, "agent-a");
  expect(loadBudget(root, home).inflight).toEqual({ old: { stage: "stills", ts: T0 } });
});

test("corrupt budget: pruneInflight and releaseSessionRenders throw without touching the file", () => {
  const { root, home } = fixture();
  openRender(root, "seed", "stills", 1, home);
  const file = budgetFile(home);
  writeFileSync(file, '{"renders":{"master":"2"},"wallMs":{},"inflight":{}}');
  const before = readFileSync(file, "utf8");
  expect(() => pruneInflight(root, T0 + DEFAULT_TTL + 1, home)).toThrow("Motion budget is corrupt");
  expect(() => releaseSessionRenders(root, "s1", home, "agent-a")).toThrow("Motion budget is corrupt");
  expect(readFileSync(file, "utf8")).toBe(before);
});

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { loadBudget, openRender, releaseRender, releaseSessionRenders } from "../src/policy/motion/budget";
import { withMotionProjectLock } from "../src/policy/motion/project-lock";
import { motionSessionStop } from "../src/runtime/motion/lifecycle";
import { bash, isDeny, makeFixture } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";

const STILLS = "bash render.sh --stage stills";
const T0 = 1_000_000;

/** Run one claude-code hook payload with an injected clock and home. */
async function runAt(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  const out = await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" });
  return out.stdout;
}

/** The single project budget file created under a home. */
function budgetFile(home: string): string {
  const motion = join(home, ".fuse-harness", "video-motion");
  const dir = readdirSync(motion).find((entry) => /^[0-9a-f]{16}$/.test(entry));
  if (!dir) throw new Error("no project store under " + motion);
  return join(motion, dir, "budget.json");
}

test("SubagentStop of another agent keeps the fresh reservation blocking", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { agent_id: "agent-x" }), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "agent-y" }, T0 + 100);
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 200);
  expect(isDeny(denied)).toBe(true);
  expect(denied).toContain("Motion concurrent render");
});

test("main Stop keeps a sub-agent's fresh reservation blocking", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { agent_id: "agent-x" }), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "Stop", session_id: "s1" }, T0 + 100);
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 200);
  expect(isDeny(denied)).toBe(true);
  expect(denied).toContain("Motion concurrent render");
});

test("SubagentStop of the owning agent releases its reservation", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { agent_id: "agent-x" }), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "agent-x" }, T0 + 100);
  expect(isDeny(await runAt(fx, bash("s2", STILLS), T0 + 200))).toBe(false);
});

test("releaseSessionRenders releases only the stopped sub-agent's FRESH reservations", () => {
  const fx = makeFixture();
  const root = realpathSync(fx.proj), home = fx.home;
  openRender(root, "x1", "master", 1, home, {}, "sess-s", "agent-x");
  openRender(root, "y1", "master", 2, home, {}, "sess-s", "agent-y");
  openRender(root, "m1", "master", 3, home, {}, "sess-s");
  releaseSessionRenders(root, "sess-s", home, "agent-x");
  expect(Object.keys(loadBudget(root, home).inflight)).toEqual(["y1", "m1"]);
  releaseSessionRenders(root, "sess-s", home, "agent-y");
  expect(Object.keys(loadBudget(root, home).inflight)).toEqual(["m1"]); // the main turn's entry (no agentId) is never released
});

test("a non-string agentId makes the budget corrupt (fail-closed)", () => {
  const fx = makeFixture();
  const root = realpathSync(fx.proj), home = fx.home;
  openRender(root, "seed", "stills", T0, home);
  releaseRender(root, "seed", home);
  writeFileSync(budgetFile(home), JSON.stringify({ renders: {}, wallMs: {}, inflight: { bad: { stage: "stills", ts: T0, agentId: 42 } } }));
  expect(openRender(root, "next", "stills", T0 + 1, home)?.kind).toBe("block");
});

// HEAD (bd6e6d3) renders exactly this deny for the same scenario: the tampered
// store trips state verification before any release runs. Parity is the contract.
const HEAD_CORRUPT_STOP = '{"decision":"block","reason":"Motion protected project/store/key state changed outside the harness; all approvals invalidated. Owner re-approval required."}';

test("corrupt budget: Stop output is byte-identical to HEAD and the file is untouched", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS), T0))).toBe(false);
  const path = budgetFile(fx.home);
  writeFileSync(path, '{"renders":{"master":"2"},"wallMs":{},"inflight":{}}');
  const before = readFileSync(path, "utf8");
  const out = await runAt(fx, { hook_event_name: "Stop", session_id: "s1" }, T0 + 100);
  expect(out).toBe(HEAD_CORRUPT_STOP);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("busy budget lock: SubagentStop release is best-effort (no throw, reservation kept)", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { agent_id: "agent-x" }), T0))).toBe(false);
  const root = realpathSync(fx.proj);
  withMotionProjectLock(root, fx.home, () => {
    expect(() => releaseSessionRenders(root, "s1", fx.home, "agent-x")).toThrow("lock busy"); // proves the contention path
    motionSessionStop("s1", "agent-x", fx.home); // must swallow the same failure
  });
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 100);
  expect(isDeny(denied)).toBe(true);
  expect(denied).toContain("Motion concurrent render");
});

test("SubagentStop WITHOUT agent_id releases nothing (old host versions)", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { agent_id: "agent-x" }), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "SubagentStop", session_id: "s1" }, T0 + 100);
  const denied = await runAt(fx, bash("s2", STILLS), T0 + 200);
  expect(isDeny(denied)).toBe(true);
  expect(denied).toContain("Motion concurrent render");
});

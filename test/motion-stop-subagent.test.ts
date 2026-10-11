import { expect, test } from "bun:test";
import { handleHook } from "../src/runtime/handle";
import { loadBudget, openRender, pruneInflight } from "../src/policy/motion/budget";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { codeOf, makeFixture } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";
import type { Host } from "./motion-hosts-fixture";
import { denied, postShell, shell, silent, userPrompt } from "./motion-hosts-fixture";

const STILLS = "bash render.sh --stage stills";
const DRAFT = "bash render.sh --stage draft";
const T0 = 1_000_000;
const TTL = 1_800_000;

/** Run one hook payload of a host with an injected clock and home. */
async function runHost(fx: MotionFixture, h: Host, payload: Record<string, unknown>, now: number): Promise<string> {
  return (await handleHook(h, payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

/** Run one gemini-cli hook payload (no native tool_use_id -> `noid:` render id) with an injected clock and home. */
async function runGemini(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  return runHost(fx, "gemini-cli", payload, now);
}

test("sub-agent AfterAgent (agent_name, no agent_id) releases NOTHING of the main turn", async () => {
  const fx = makeFixture();
  const pre = shell("gemini-cli", "g1", STILLS, fx.proj);
  expect(denied("gemini-cli", await runGemini(fx, pre, T0))).toBe(false);
  const stop = await runGemini(fx, { hook_event_name: "AfterAgent", session_id: "g1", agent_name: "codebase_investigator" }, T0 + 10);
  expect(silent(stop)).toBe(true); // stdout of these events unchanged vs HEAD
  const again = await runGemini(fx, pre, T0 + 20);
  expect(denied("gemini-cli", again)).toBe(true); // the main turn's fresh reservation still blocks
  await runGemini(fx, postShell("gemini-cli", "g1", STILLS, fx.proj), T0 + 30);
  expect(loadBudget(canonicalRoot(fx.proj), fx.home).renders.stills).toBe(1);
});

test("main-turn AfterAgent on gemini-cli releases NOTHING either (Stop release is claude-code only)", async () => {
  const fx = makeFixture();
  const pre = shell("gemini-cli", "g1", STILLS, fx.proj);
  expect(denied("gemini-cli", await runGemini(fx, pre, T0))).toBe(false);
  expect(silent(await runGemini(fx, { hook_event_name: "AfterAgent", session_id: "g1" }, T0 + 10))).toBe(true);
  const again = await runGemini(fx, pre, T0 + 20);
  expect(denied("gemini-cli", again)).toBe(true); // no release on gemini-cli: the fresh reservation still blocks
  await runGemini(fx, postShell("gemini-cli", "g1", STILLS, fx.proj), T0 + 30);
  expect(loadBudget(canonicalRoot(fx.proj), fx.home).renders.stills).toBe(1);
});

test("kimi: a marker-free Stop releases NOTHING of the main turn (a sub-agent Stop is indistinguishable)", async () => {
  const fx = makeFixture();
  const run = (payload: Record<string, unknown>, now: number) => runHost(fx, "kimi", payload, now);
  const preDraft = (callId: string): Record<string, unknown> =>
    ({ hook_event_name: "PreToolUse", session_id: "k1", tool_call_id: callId, tool_name: "Bash", tool_input: { command: DRAFT }, cwd: fx.proj });
  const gated = await run(preDraft("gate-0"), T0 - 10);
  expect(denied("kimi", gated)).toBe(true); // G1: stills approval required first
  await run(userPrompt("kimi", "k1", `MOTION-APPROVE stills ${codeOf(gated)}`, fx.proj), T0 - 5);
  expect(denied("kimi", await run(preDraft("main-1"), T0))).toBe(false); // reservation taken
  expect(silent(await run({ hook_event_name: "Stop", session_id: "k1" }, T0 + 10))).toBe(true);
  const again = await run(preDraft("other-2"), T0 + 20);
  expect(denied("kimi", again)).toBe(true);
  expect(again).toContain("Motion concurrent render"); // the Stop did not free main-1
  await run({ ...preDraft("main-1"), hook_event_name: "PostToolUse" }, T0 + 30);
  expect(loadBudget(canonicalRoot(fx.proj), fx.home).renders.draft).toBe(1); // still settleable
});

test("cursor: stop releases NOTHING (noid host; the TTL is the only backstop)", async () => {
  const fx = makeFixture();
  const run = (payload: Record<string, unknown>, now: number) => runHost(fx, "cursor", payload, now);
  const pre = shell("cursor", "cu1", STILLS, fx.proj);
  expect(denied("cursor", await run(pre, T0))).toBe(false);
  const stop = await run({ hook_event_name: "stop", conversation_id: "cu1", generation_id: "g1", cwd: fx.proj, workspace_roots: [fx.proj] }, T0 + 10);
  expect(silent(stop)).toBe(true);
  const again = await run(pre, T0 + 20);
  expect(denied("cursor", again)).toBe(true);
  expect(again).toContain("Motion concurrent render");
});

test("codex: main-turn Stop releases NOTHING either (pass 8: no Stop release on any host)", async () => {
  const fx = makeFixture();
  const run = (payload: Record<string, unknown>, now: number) => runHost(fx, "codex", payload, now);
  const pre = shell("codex", "x1", STILLS, fx.proj);
  expect(denied("codex", await run(pre, T0))).toBe(false);
  expect(silent(await run({ hook_event_name: "Stop", session_id: "x1" }, T0 + 10))).toBe(true);
  const again = await run({ ...pre, tool_use_id: "t-x2" }, T0 + 20);
  expect(denied("codex", again)).toBe(true);
  expect(again).toContain("Motion concurrent render"); // the Stop did not free the reservation
  expect(denied("codex", await run({ ...pre, tool_use_id: "t-x3" }, T0 + TTL + 1))).toBe(false); // the TTL is the backstop
});

test("codex: SubagentStop with an agent_id releases NOTHING (a codex sub-agent can stop while its render still runs)", async () => {
  const fx = makeFixture();
  const run = (payload: Record<string, unknown>, now: number) => runHost(fx, "codex", payload, now);
  const pre = { ...shell("codex", "x1", STILLS, fx.proj), agent_id: "agent-x" };
  expect(denied("codex", await run(pre, T0))).toBe(false);
  expect(silent(await run({ hook_event_name: "SubagentStop", session_id: "x1", agent_id: "agent-x" }, T0 + 10))).toBe(true);
  const blocked = await run({ ...pre, tool_use_id: "t-x2" }, T0 + 20);
  expect(denied("codex", blocked)).toBe(true); // no release on codex: the fresh reservation still blocks
  expect(blocked).toContain("Motion concurrent render");
  await run({ ...pre, hook_event_name: "PostToolUse" }, T0 + 30); // the still-running render completes late
  expect(loadBudget(canonicalRoot(fx.proj), fx.home).renders.stills).toBe(1); // the late post is counted
});

test("openRender refuses an id retained in expired (an id never lives in both maps)", () => {
  const fx = makeFixture();
  const root = canonicalRoot(fx.proj), home = fx.home;
  expect(openRender(root, "tu-x", "stills", T0, home)).toBeNull();
  const fresh = openRender(root, "tu-x", "stills", T0 + 1, home);
  expect(fresh?.kind).toBe("block"); // fresh duplicate: HEAD refusal, unchanged
  expect(fresh?.reason).toContain("already has an in-flight render reservation");
  pruneInflight(root, T0 + TTL + 1, home); // moves tu-x to the retained expired map
  expect(loadBudget(root, home).expired?.["tu-x"]).toBeDefined();
  const again = openRender(root, "tu-x", "stills", T0 + TTL + 2, home);
  expect(again?.kind).toBe("block");
  expect(again?.reason).toContain("already has an in-flight render reservation");
  const budget = loadBudget(root, home);
  expect(budget.inflight["tu-x"]).toBeUndefined(); // refused: the id never lives in both maps
  expect(budget.expired?.["tu-x"]).toBeDefined();
});

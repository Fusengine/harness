import { expect, test } from "bun:test";
import { handleHook } from "../src/runtime/handle";
import { loadBudget } from "../src/policy/motion/budget";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { bash, isDeny, makeFixture } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";
import { denied, postShell, shell } from "./motion-hosts-fixture";

const STILLS = "bash render.sh --stage stills";
const T0 = 1_000_000;
const TTL = 1_800_000;
const FORGET = 24 * 60 * 60 * 1000; // RENDER_FORGET_MS: expired reservations are forgotten past 24 h

/** Run one gemini-cli hook payload (no native tool_use_id -> `noid:` render id) with an injected clock and home. */
async function runGemini(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  return (await handleHook("gemini-cli", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

/** Run one claude-code hook payload with an injected clock and home. */
async function runClaude(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  return (await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

test("expired noid reservation: the same command is refused until its late completion settles", async () => {
  const fx = makeFixture();
  const pre = shell("gemini-cli", "g1", STILLS, fx.proj);
  expect(denied("gemini-cli", await runGemini(fx, pre, T0))).toBe(false);
  const again = await runGemini(fx, pre, T0 + TTL + 10);
  expect(denied("gemini-cli", again)).toBe(true);
  expect(again).toContain("Motion render identity");
  await runGemini(fx, postShell("gemini-cli", "g1", STILLS, fx.proj), T0 + TTL + 20);
  const budget = loadBudget(canonicalRoot(fx.proj), fx.home);
  expect(budget.renders.stills).toBe(1);
  expect(budget.wallMs.stills).toBe(TTL + 20);
  expect(denied("gemini-cli", await runGemini(fx, pre, T0 + TTL + 30))).toBe(false);
});

test("host Stop (gemini-cli AfterAgent) releases NOTHING: the expired noid refuses until the 24 h horizon", async () => {
  const fx = makeFixture();
  const pre = shell("gemini-cli", "g1", STILLS, fx.proj);
  expect(denied("gemini-cli", await runGemini(fx, pre, T0))).toBe(false); // leak: the tool never runs
  const refused = await runGemini(fx, pre, T0 + TTL + 10);
  expect(denied("gemini-cli", refused)).toBe(true); // expired noid: the same command stays refused
  expect(refused).toContain("Motion render identity");
  await runGemini(fx, { hook_event_name: "AfterAgent", session_id: "g1" }, T0 + TTL + 20);
  const still = await runGemini(fx, pre, T0 + TTL + 30);
  expect(denied("gemini-cli", still)).toBe(true); // Stop release is claude-code only
  expect(still).toContain("Motion render identity");
  expect(denied("gemini-cli", await runGemini(fx, pre, T0 + FORGET + 1))).toBe(false); // the horizon forgets it
});

test("native-id host: Stop keeps an EXPIRED reservation settleable (pass-3 behavior unchanged)", async () => {
  const fx = makeFixture();
  const pre = bash("c1", STILLS, { tool_use_id: "tu-c1" });
  expect(isDeny(await runClaude(fx, pre, T0))).toBe(false);
  await runClaude(fx, { hook_event_name: "Stop", session_id: "c1" }, T0 + TTL + 10);
  await runClaude(fx, { ...pre, hook_event_name: "PostToolUse" }, T0 + TTL + 20);
  const budget = loadBudget(canonicalRoot(fx.proj), fx.home);
  expect(budget.renders.stills).toBe(1);
  expect(budget.wallMs.stills).toBe(TTL + 20);
});

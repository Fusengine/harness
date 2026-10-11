import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { MAX_MASTER_ENV, closeRender, loadBudget, openRender } from "../src/policy/motion/budget";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { bash, codeOf, isDeny, makeFixture, prompt } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";

const STILLS = "bash render.sh --stage stills";
const DRAFT = "bash render.sh --stage draft";
const T0 = 1_000_000;
const TTL = 1_800_000;
/** Forget horizon: matches RENDER_FORGET_MS in src/policy/motion/budget.ts (24 h). */
const FORGET = 24 * 60 * 60 * 1000;

const dirs = (): { root: string; home: string } => ({
  root: realpathSync(mkdtempSync(join(tmpdir(), "motion-late-root-"))),
  home: realpathSync(mkdtempSync(join(tmpdir(), "motion-late-home-"))),
});

/** Run one claude-code hook payload with an injected clock and home. */
async function runAt(fx: MotionFixture, payload: Record<string, unknown>, now: number): Promise<string> {
  const out = await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" });
  return out.stdout;
}

/** Approve stills on the injected clock so a draft render passes G1. */
async function approveStills(fx: MotionFixture, now: number): Promise<void> {
  const denied = await runAt(fx, bash("s1", DRAFT, { tool_use_id: "tu-gate" }), now);
  expect(isDeny(denied)).toBe(true);
  expect(await runAt(fx, prompt("s1", `MOTION-APPROVE stills ${codeOf(denied)}`), now)).toContain("approved");
}

test("challenger repro: a late master completion counts against the cap, with full wall time", () => {
  const { root, home } = dirs();
  const env = { [MAX_MASTER_ENV]: "1" };
  expect(openRender(root, "a", "master", T0, home, env)).toBeNull();
  expect(openRender(root, "s", "stills", T0 + TTL + 1, home, env)).toBeNull(); // expired reservation does not block admission
  closeRender(root, "a", "master", T0 + TTL + 100, home); // same settlement as HEAD for the unexpired render
  const budget = loadBudget(root, home);
  expect(budget.renders.master).toBe(1);
  expect(budget.wallMs.master).toBe(TTL + 100);
  expect(budget.inflight.a).toBeUndefined();
  expect(budget.expired ?? {}).toEqual({});
  expect(openRender(root, "c", "master", T0 + TTL + 200, home, env)?.kind).toBe("block"); // the cap saw the late finisher
});

test("late draft completion after TTL: output attributed (no quarantine), budget counted", async () => {
  const fx = makeFixture();
  await approveStills(fx, T0);
  const preA = bash("s1", DRAFT, { tool_use_id: "tu-a" });
  expect(isDeny(await runAt(fx, preA, T0))).toBe(false);
  writeFileSync(fx.draft, "late-authorized-draft");
  const admit = await runAt(fx, bash("s1", DRAFT, { tool_use_id: "tu-b" }), T0 + TTL + 1);
  expect(isDeny(admit)).toBe(false); // the expired reservation no longer blocks
  const out = await runAt(fx, { ...preA, hook_event_name: "PostToolUse" }, T0 + TTL + 2);
  expect(out).not.toContain("quarantin");
  expect(out).toContain("Motion budget: renders stills 0 · draft 1");
  expect(existsSync(fx.draft)).toBe(true);
  expect(readFileSync(fx.draft, "utf8")).toBe("late-authorized-draft");
  const budget = loadBudget(canonicalRoot(fx.proj), fx.home);
  expect(budget.renders.draft).toBe(1);
  expect(budget.wallMs.draft).toBe(TTL + 2);
  expect(Object.keys(budget.inflight)).toHaveLength(1); // the newer render stays reserved
  expect(Object.keys(budget.inflight)[0]).toContain("tu-b");
});

test("late failure after TTL releases without counting (HEAD parity)", async () => {
  const fx = makeFixture();
  await approveStills(fx, T0);
  const preA = bash("s1", DRAFT, { tool_use_id: "tu-f" });
  expect(isDeny(await runAt(fx, preA, T0))).toBe(false);
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { tool_use_id: "tu-other" }), T0 + TTL + 1))).toBe(false);
  await runAt(fx, { ...preA, hook_event_name: "PostToolUseFailure", error: "cancelled" }, T0 + TTL + 2);
  const budget = loadBudget(canonicalRoot(fx.proj), fx.home);
  expect(budget.renders.draft ?? 0).toBe(0);
  expect(budget.inflight["tu-f"]).toBeUndefined();
  expect(budget.expired?.["tu-f"]).toBeUndefined();
});

test("a leaked reservation never blocks again and is forgotten past the 24h horizon", () => {
  const { root, home } = dirs();
  expect(openRender(root, "a", "stills", T0, home)).toBeNull();
  expect(openRender(root, "b", "stills", T0 + TTL + 1, home)).toBeNull(); // leak fix: admission not blocked
  expect(loadBudget(root, home).expired).toEqual({ a: { stage: "stills", ts: T0 } }); // retained, not forgotten
  expect(openRender(root, "c", "stills", T0 + FORGET + 1, home)).toBeNull(); // still no block
  const budget = loadBudget(root, home);
  expect(Object.keys(budget.inflight)).toEqual(["c"]);
  expect(Object.keys(budget.expired ?? {})).toEqual(["b"]); // "a" forgotten at the horizon, "b" retained
});

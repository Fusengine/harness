import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { loadBudget } from "../src/policy/motion/budget";
import { budgetPath } from "../src/policy/motion/budget-store";
import { rootKey } from "../src/policy/motion/hash";
import { motionHome } from "../src/policy/motion/store";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { bash, codeOf, isDeny, makeFixture, prompt } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";
import { denied, shell } from "./motion-hosts-fixture";

const STILLS = "bash render.sh --stage stills";
const STILLS_ALT = "bash render.sh";
const DRAFT = "bash render.sh --stage draft";
const T0 = 1_000_000;

/** Run one claude-code hook payload with an injected clock and home. */
async function runAt(fx: MotionFixture, payload: Record<string, unknown>, now: number = T0): Promise<string> {
  return (await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

/** Run one gemini-cli hook payload (no native tool_use_id -> `noid:` render id) with an injected clock and home. */
async function runGemini(fx: MotionFixture, payload: Record<string, unknown>, now: number = T0): Promise<string> {
  return (await handleHook("gemini-cli", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

/** Harness-owned on-disk state of the fixture project (budget + motion state registry). */
function diskState(fx: MotionFixture): { budget: string; state: string } {
  const root = canonicalRoot(fx.proj);
  return {
    budget: readFileSync(budgetPath(root, fx.home), "utf8"),
    state: readFileSync(join(motionHome(fx.home), "state", `${rootKey(root)}.json`), "utf8"),
  };
}

test("a duplicated PreToolUse with the same native tool_use_id is idempotent", async () => {
  const fx = makeFixture();
  const pre = bash("s1", STILLS, { tool_use_id: "tu-dup" });
  rmSync(fx.draft); // no cold artifact: the one-time first-observation notice is not emitted
  const first = await runAt(fx, pre);
  expect(isDeny(first)).toBe(false);
  const before = diskState(fx);
  const second = await runAt(fx, pre);
  expect(isDeny(second)).toBe(false);
  expect(second).toBe(first); // the same "Motion render" note as the first pass
  expect(diskState(fx)).toEqual(before); // budget + state unchanged, byte for byte
  const inflight = Object.keys(loadBudget(canonicalRoot(fx.proj), fx.home).inflight);
  expect(inflight).toHaveLength(1); // a single reservation, under the scoped id
  expect(inflight[0]).toContain("tu-dup");
});

test("another tool_use_id of the same stage is still refused while the reservation is fresh", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { tool_use_id: "tu-a" })))).toBe(false);
  const concurrent = await runAt(fx, bash("s1", STILLS, { tool_use_id: "tu-b" }));
  expect(isDeny(concurrent)).toBe(true);
  expect(concurrent).toContain("Motion concurrent render");
});

test("the same tool_use_id with a different command, session or stage keeps the existing refusal", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { tool_use_id: "tu-a" })))).toBe(false);
  expect(isDeny(await runAt(fx, bash("s1", STILLS_ALT, { tool_use_id: "tu-a" })))).toBe(true); // other command
  expect(isDeny(await runAt(fx, bash("s2", STILLS, { tool_use_id: "tu-a" })))).toBe(true); // other session
  const gate = await runAt(fx, bash("s1", DRAFT, { tool_use_id: "tu-gate" })); // approve stills so draft passes G1
  expect(isDeny(gate)).toBe(true);
  expect(await runAt(fx, prompt("s1", `MOTION-APPROVE stills ${codeOf(gate)}`))).toContain("approved");
  expect(isDeny(await runAt(fx, bash("s1", DRAFT, { tool_use_id: "tu-a" })))).toBe(true); // other stage
});

test("a host without native ids (gemini-cli) still refuses the second identical pre", async () => {
  const fx = makeFixture();
  const pre = shell("gemini-cli", "g1", STILLS, fx.proj);
  expect(denied("gemini-cli", await runGemini(fx, pre))).toBe(false);
  expect(denied("gemini-cli", await runGemini(fx, pre))).toBe(true);
});

test("PostToolUse after a duplicated pre counts the render exactly once", async () => {
  const fx = makeFixture();
  const pre = bash("s1", STILLS, { tool_use_id: "tu-dup" });
  expect(isDeny(await runAt(fx, pre))).toBe(false);
  expect(isDeny(await runAt(fx, pre))).toBe(false);
  const post = await runAt(fx, { ...pre, hook_event_name: "PostToolUse" });
  expect(post).toContain("renders stills 1");
  const budget = loadBudget(canonicalRoot(fx.proj), fx.home);
  expect(budget.renders.stills).toBe(1);
  expect(budget.inflight["tu-dup"]).toBeUndefined();
});

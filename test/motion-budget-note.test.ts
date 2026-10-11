import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { handleHook } from "../src/runtime/handle";
import { loadBudget } from "../src/policy/motion/budget";
import { budgetPath } from "../src/policy/motion/budget-store";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { bash, isDeny, makeFixture } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";

const STILLS = "bash render.sh --stage stills";
const T0 = 1_000_000;

/** Run one claude-code hook payload with an injected clock and home. */
async function runAt(fx: MotionFixture, payload: Record<string, unknown>, now: number = T0): Promise<string> {
  return (await handleHook("claude-code", payload, { now, cwd: fx.proj, home: fx.home, scope: "motion" })).stdout;
}

test("the pre note counts COMPLETED renders and stays in sync with budget.json", async () => {
  const fx = makeFixture();
  rmSync(fx.draft); // no cold artifact: the one-time first-observation notice is not emitted
  const pre1 = bash("s1", STILLS, { tool_use_id: "tu-a" });
  const note1 = await runAt(fx, pre1);
  expect(isDeny(note1)).toBe(false);
  // The pre note is emitted BEFORE the PostToolUse that increments the counter:
  // 0 completed renders, 1 reservation in flight — "stills 0" is correct here.
  expect(note1).toContain("Motion budget: renders stills 0 · draft 0 · master 0");
  const post = await runAt(fx, { ...pre1, hook_event_name: "PostToolUse" });
  expect(post).toContain("renders stills 1");
  const root = canonicalRoot(fx.proj);
  const onDisk = JSON.parse(readFileSync(budgetPath(root, fx.home), "utf8")) as { renders: Record<string, number> };
  expect(onDisk.renders.stills).toBe(1);
  expect(loadBudget(root, fx.home).renders.stills).toBe(1);
  // A NEW pre after the settlement reads a fresh budget: the note matches budget.json.
  const note2 = await runAt(fx, bash("s1", STILLS, { tool_use_id: "tu-b" }));
  expect(isDeny(note2)).toBe(false);
  expect(note2).toContain("Motion budget: renders stills 1 · draft 0 · master 0");
});

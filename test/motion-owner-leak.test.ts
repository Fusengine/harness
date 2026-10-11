import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleHook } from "../src/runtime/handle";
import { bash, codeOf, isDeny, makeFixture, prompt } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";

const STILLS = "bash render.sh --stage stills";
const DRAFT = "bash render.sh --stage draft";
const T0 = 1_000_000;
const TTL = 1_800_000;

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

test("leaked stills reservation, then after TTL a new stills render completes and G1 proceeds", async () => {
  const fx = makeFixture();
  const leak = await runAt(fx, bash("s1", STILLS, { tool_use_id: "leak-1" }), T0);
  expect(isDeny(leak)).toBe(false); // reservation taken; the tool never runs, no Post ever comes
  const blocked = await runAt(fx, bash("s1", STILLS, { tool_use_id: "s-2" }), T0 + 1000);
  expect(blocked).toContain("Motion concurrent render"); // guard intact while the reservation is live
  const preS3 = bash("s1", STILLS, { tool_use_id: "s-3" });
  expect(isDeny(await runAt(fx, preS3, T0 + TTL + 1))).toBe(false); // expired leak no longer blocks
  writeFileSync(fx.contact, "contact-v2");
  const postS3 = await runAt(fx, { ...preS3, hook_event_name: "PostToolUse" }, T0 + TTL + 50);
  expect(postS3).not.toContain("quarantin"); // the new render's output is attributed, not quarantined
  expect(readFileSync(fx.contact, "utf8")).toBe("contact-v2");
  await approveStills(fx, T0 + TTL + 50);
  expect(isDeny(await runAt(fx, bash("s1", DRAFT, { tool_use_id: "d-2" }), T0 + TTL + 60))).toBe(false);
});

test("leaked main-turn reservation is NOT released on Stop; it falls after the TTL", async () => {
  const fx = makeFixture();
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { tool_use_id: "leak-1" }), T0))).toBe(false);
  await runAt(fx, { hook_event_name: "Stop", session_id: "s1" }, T0 + 10);
  const blocked = await runAt(fx, bash("s1", STILLS, { tool_use_id: "s-2" }), T0 + 20);
  expect(isDeny(blocked)).toBe(true); // pass 8: the main Stop releases nothing (entry without agentId — old-version case)
  expect(blocked).toContain("Motion concurrent render");
  expect(isDeny(await runAt(fx, bash("s1", STILLS, { tool_use_id: "s-3" }), T0 + TTL + 1))).toBe(false); // the TTL is the backstop
});

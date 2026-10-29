import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, run, bash, prompt, codeOf, type MotionFixture } from "./motion-handle-fixture";
import { rootKey } from "../src/policy/motion/hash";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";

const fixtures: MotionFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true }); });

test("state second line quarantines an indirect master mutation after unrelated tool", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("state", "ls"));
  const path = join(f.proj, "out/master.mp4");
  writeFileSync(path, "unauthorized");
  const out = await run(f, { hook_event_name: "PostToolUse", session_id: "state", tool_name: "Bash", tool_use_id: "other", tool_input: { command: "ls" } });
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(join(f.proj, ".motion/quarantine")).length).toBeGreaterThan(0);
  expect(out).toContain("quarantin");
});

test("same authorized draft completion earns a receipt, later tool mutation does not", async () => {
  const f = makeFixture(); fixtures.push(f);
  const denied = await run(f, bash("authorized", "bash render.sh --stage draft"));
  await run(f, prompt("authorized", `MOTION-APPROVE stills ${codeOf(denied)}`));
  const pre = bash("authorized", "bash render.sh --stage draft", { tool_use_id: "render-1" });
  expect(await run(f, pre)).not.toContain('"permissionDecision":"deny"');
  writeFileSync(f.draft, "authorized-result");
  expect(await run(f, { ...pre, hook_event_name: "PostToolUse" })).not.toContain("quarantin");
  expect(existsSync(f.draft)).toBe(true);
  writeFileSync(f.draft, "unrelated-result");
  expect(await run(f, { ...pre, tool_use_id: "other", hook_event_name: "PostToolUse", tool_input: { command: "ls" } })).toContain("quarantin");
  expect(existsSync(f.draft)).toBe(false);
});

test("registry removal after activation fails closed rather than resetting baseline", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("registry", "ls"));
  unlinkSync(join(f.home, ".fuse-harness/video-motion/state", `${rootKey(canonicalRoot(f.proj))}.json`));
  expect(await run(f, bash("registry", "ls"))).toContain("invalidated");
});

test("external contract mutation invalidates approval and catches unapproved output", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("contract", "ls"));
  writeFileSync(join(f.proj, ".motion/project.json"), "{}");
  writeFileSync(join(f.proj, "out/master.mp4"), "unapproved");
  const out = await run(f, { hook_event_name: "PostToolUse", session_id: "contract", tool_name: "Bash", tool_input: { command: "ls" } });
  expect(out).toContain("invalidated");
  expect(out).toContain("quarantin");
  expect(existsSync(join(f.proj, "out/master.mp4"))).toBe(false);
});

test("Stop finds parent-session project and catches draft changes", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("state-stop", "ls"));
  writeFileSync(f.draft, "changed");
  const out = await run(f, { hook_event_name: "Stop", session_id: "state-stop" }, "motion", f.base);
  expect(existsSync(f.draft)).toBe(false);
  expect(out).toContain("quarantin");
});

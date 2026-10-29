import { test, expect } from "bun:test";
import { join } from "node:path";
import { loadBudget } from "../src/policy/motion/budget";
import { loadMotionProject } from "../src/policy/motion/project";
import { bash, isDeny, makeFixture, run } from "./motion-handle-fixture";

const write = (sid: string, file: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Write", tool_input: { file_path: file, content: "hello" }, ...extra });
const sub = (event: string, sid: string, agentId: string, agentType: string): Record<string, unknown> =>
  ({ hook_event_name: event, session_id: sid, agent_id: agentId, agent_type: agentType });

test("critic flag set on SubagentStart, cleared by agent_id alone on SubagentStop", async () => {
  const fx = makeFixture();
  const target = join(fx.proj, "src", "x.txt");
  expect(isDeny(await run(fx, write("c1", target)))).toBe(false);
  expect(await run(fx, sub("SubagentStart", "c1", "a1", "fuse-motion:motion-critic"))).toBe("");
  expect(isDeny(await run(fx, write("c1", target)))).toBe(true);
  expect(await run(fx, sub("SubagentStop", "c1", "a1", "something-else"))).toBe("");
  expect(isDeny(await run(fx, write("c1", target)))).toBe(false);
});

test("a non-critic SubagentStart sets no flag", async () => {
  const fx = makeFixture();
  await run(fx, sub("SubagentStart", "c2", "a2", "Explore"));
  expect(isDeny(await run(fx, write("c2", join(fx.proj, "src", "y.txt"))))).toBe(false);
});

test("self-approval: Write into the motion store is denied, even outside a motion project", async () => {
  const fx = makeFixture();
  const store = join(fx.home, ".fuse-harness", "video-motion", "x", "approvals.json");
  expect(isDeny(await run(fx, write("w1", store)))).toBe(true);
  expect(isDeny(await run(fx, write("w1", store), "motion", fx.base))).toBe(true);
  expect(isDeny(await run(fx, bash("w1", `echo '{}' > ${store}`)))).toBe(true);
});

test("outside a motion project the gates stay out of the way", async () => {
  const fx = makeFixture();
  expect(await run(fx, bash("o1", "bash render.sh --stage draft"), "motion", fx.base)).toBe("");
});

test("scope core: the same payload yields no motion deny", async () => {
  const fx = makeFixture();
  const payload = bash("k1", "bash render.sh --stage draft");
  expect(isDeny(await run(fx, payload, "motion"))).toBe(true);
  const realHome = process.env["HOME"]; // keep core state writes (homedir()) inside the temp dir
  process.env["HOME"] = fx.home;
  try {
    expect(await run(fx, payload, "core")).not.toContain("Motion approval gate");
    expect(await run(fx, payload, null)).not.toContain("Motion approval gate");
  } finally {
    if (realHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = realHome;
  }
});

test("motion scope ignores other events (SessionStart) with empty stdout", async () => {
  const fx = makeFixture();
  await run(fx, bash("z", "ls"));
  expect(await run(fx, { hook_event_name: "SessionStart", session_id: "z" })).toBe("");
});

test("PostToolUse of the render increments the budget", async () => {
  const fx = makeFixture();
  const post = (n: number): Record<string, unknown> => ({
    hook_event_name: "PostToolUse", session_id: "b1", tool_name: "Bash", tool_use_id: `tu-${n}`,
    tool_input: { command: "bash render.sh" }, tool_response: "ok",
  });
  for (const n of [1, 2]) {
    const pre = await run(fx, bash("b1", "bash render.sh", { tool_use_id: `tu-${n}` }));
    expect(isDeny(pre)).toBe(false);
    expect(await run(fx, post(n))).toContain("PostToolUse");
  }
  const project = loadMotionProject(fx.proj, fx.home);
  expect(project).not.toBeNull();
  expect(loadBudget(project?.root ?? "", fx.home).renders.stills).toBe(2);
});

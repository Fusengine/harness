import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBudget } from "../src/policy/motion/budget";
import { loadMotionProject } from "../src/policy/motion/project";
import { selfApprovalViolation as v } from "../src/policy/motion/self-approval";
import { bash, codeOf, isDeny, makeFixture, prompt, run } from "./motion-handle-fixture";
import type { MotionFixture } from "./motion-handle-fixture";
import { completeDraft } from "./motion-hardening5-fixture";

const DRAFT = "bash render.sh --stage draft";
const FFMPEG = "ffmpeg -i out/draft.mp4 out/master.mp4";
const locked: string[] = [];
afterEach(() => {
  for (const p of locked.splice(0)) chmodSync(p, 0o700);
  delete process.env["FUSE_MOTION_MAX_MASTER_RENDERS"];
});

const store = (fx: MotionFixture): string => join(fx.home, ".fuse-harness", "video-motion");

test("D1: motion store is a regular file -> missing approval still denies", async () => {
  const fx = makeFixture();
  mkdirSync(join(fx.home, ".fuse-harness"), { recursive: true });
  writeFileSync(store(fx), "not a dir");
  const out = await run(fx, bash("d1a", DRAFT));
  expect(isDeny(out)).toBe(true);
  expect(out).toContain("Owner: type MOTION-APPROVE stills");
});

test("D1: motion store is chmod 500 -> missing approval still denies", async () => {
  const fx = makeFixture();
  mkdirSync(store(fx), { recursive: true });
  chmodSync(store(fx), 0o500);
  locked.push(store(fx));
  expect(isDeny(await run(fx, bash("d1b", DRAFT)))).toBe(true);
});

test("D2: harness-dir reads and non-store deletes are allowed", () => {
  expect(v("Bash", undefined, "cd ~/.fuse-harness && ls")).toBeNull();
  expect(v("Bash", undefined, "grep -r fuse ~/.fuse-harness/cache | sort")).toBeNull();
  expect(v("Bash", undefined, "rm -rf ~/.fuse-harness/cache/x")).toBeNull();
});

test("D2: store writes, deletes, moves, chmod and interpreters stay blocked", () => {
  const blocked = [
    "rm -rf ~/.fuse-harness/video-motion",
    "rm ~/.fuse-harness/video-motion/k/approvals.json",
    "mv /tmp/a ~/.fuse-harness/video-motion/k/approvals.json",
    "chmod 777 ~/.fuse-harness/video-motion/k",
    "cd ~/.fuse-harness && rm -rf video-motion",
    "rm -rf ~/.fuse-harness",
    'python3 -c "open(\'/Users/u/.fuse-harness/video-motion/k/approvals.json\',\'w\')"',
    "perl -e 'unlink q(/Users/u/.fuse-harness/video-motion/k/approvals.json)'",
    'ruby -e "File.write(%q(/u/.fuse-harness/video-motion/approvals.json),1)"',
    "sh -c 'echo {} > ~/.fuse-harness/video-motion/k/approvals.json'",
    "bun -e 'Bun.write(process.env.HOME+\"/.fuse-harness/Video-Motion/x\",1)'",
  ];
  for (const c of blocked) expect(v("Bash", undefined, c)?.kind).toBe("block");
});

test("D3: ffmpeg to a declared master counts +1 and respects the cap", async () => {
  process.env["FUSE_MOTION_MAX_MASTER_RENDERS"] = "1";
  const fx = makeFixture();
  await completeDraft(fx);
  const denied = await run(fx, bash("d3", FFMPEG));
  expect(denied).toContain("Owner: type MOTION-APPROVE draft");
  await run(fx, prompt("d3", `MOTION-APPROVE draft ${codeOf(denied)}`));
  expect(isDeny(await run(fx, bash("d3", FFMPEG, { tool_use_id: "m1" })))).toBe(false);
  writeFileSync(join(fx.proj, "out/master.mp4"), "authorized-ffmpeg-master");
  const post = { hook_event_name: "PostToolUse", session_id: "d3", tool_name: "Bash", tool_use_id: "m1", tool_input: { command: FFMPEG }, tool_response: "ok" };
  expect(await run(fx, post)).toContain("master 1/1");
  const root = loadMotionProject(fx.proj, fx.home)?.root ?? "";
  expect(loadBudget(root, fx.home).renders.master).toBe(1);
  const second = await run(fx, bash("d3", FFMPEG, { tool_use_id: "m2" }));
  expect(isDeny(second)).toBe(true);
  expect(second).toContain("Master render cap reached (1/1");
});

const ap = "MOTION-APPROVE draft 1a2b";
const tool = (name: string, input: Record<string, unknown>): Record<string, unknown> =>
  ({ hook_event_name: "PreToolUse", session_id: "d4", tool_name: name, tool_use_id: "tu", tool_input: input });

test("D4: Bash carrying MOTION-APPROVE (any case) is denied", async () => {
  const fx = makeFixture();
  expect(isDeny(await run(fx, bash("d4", `claude -p --resume abc "${ap}"`)))).toBe(true);
  expect(isDeny(await run(fx, bash("d4", `echo ${ap.toLowerCase()}`)))).toBe(true);
  expect(isDeny(await run(fx, bash("d4", "echo hello")))).toBe(false);
});

test("D4: scheduling / messaging tools carrying the phrase are denied", async () => {
  const fx = makeFixture();
  const forms: Array<[string, Record<string, unknown>]> = [
    ["CronCreate", { cron: "* * * * *", prompt: ap }],
    ["ScheduleWakeup", { delaySeconds: 60, prompt: ap }],
    ["mcp__x__RemoteTrigger", { body: { text: ap } }],
    ["SendMessage", { to: "main", message: ap.toLowerCase() }],
  ];
  for (const [name, input] of forms) expect(isDeny(await run(fx, tool(name, input)))).toBe(true);
  expect(isDeny(await run(fx, tool("CronCreate", { cron: "* * * * *", prompt: "ls" })))).toBe(false);
});

test("D4: Write and Edit mentioning the phrase stay free (documentation)", async () => {
  const fx = makeFixture();
  const file = join(fx.proj, "NOTES.md");
  expect(isDeny(await run(fx, tool("Write", { file_path: file, content: ap })))).toBe(false);
  expect(isDeny(await run(fx, tool("Edit", { file_path: file, old_string: "a", new_string: ap })))).toBe(false);
});

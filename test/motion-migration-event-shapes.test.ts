import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixture, run } from "./motion-handle-fixture";

/** A broken Motion store inside a Motion project: each non-pre event answers in its own native shape, never as a PreToolUse decision. */
const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function brokenStore(): { fx: ReturnType<typeof makeFixture>; keys: string } {
  const fx = makeFixture();
  const target = realpathSync(mkdtempSync(join(tmpdir(), "motion-shape-")));
  made.push(target, fx.base);
  const root = join(fx.home, ".fuse-harness", "video-motion");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  symlinkSync(target, join(root, "keys"));
  return { fx, keys: join(root, "keys") };
}

test("Stop, SubagentStop, PostToolUse: top-level block decision with the real cause, no permissionDecision", async () => {
  const { fx, keys } = brokenStore();
  for (const event of ["Stop", "SubagentStop", "PostToolUse"]) {
    const out = await run(fx, { hook_event_name: event, session_id: "sh1", agent_id: "a1", tool_name: "Bash", tool_use_id: "tu-sh", tool_input: { command: "ls" } });
    expect(out).not.toContain("permissionDecision");
    expect(JSON.parse(out).decision).toBe("block");
    expect(JSON.parse(out).reason).toContain(keys);
  }
});

test("UserPromptSubmit keeps the base semantics: no PreToolUse-shaped output", async () => {
  const { fx } = brokenStore();
  const out = await run(fx, { hook_event_name: "UserPromptSubmit", session_id: "sh2", prompt: "hello" });
  expect(out).not.toContain("permissionDecision");
});

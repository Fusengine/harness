import { expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionHook } from "../src/runtime/motion";
import { normalizeEvent } from "../src/runtime/normalize";
import * as projectModule from "../src/policy/motion/project-command";
import { motionKeyViolation } from "../src/policy/motion/guard-key";

const home = realpathSync(mkdtempSync(join(tmpdir(), "motion-cwd3-")));
const root = join(home, "video");
mkdirSync(join(root, ".motion"), { recursive: true });
mkdirSync(join(home, ".fuse-harness/video-motion/keys"), { recursive: true });
symlinkSync(join(home, ".fuse-harness"), join(home, "alias"));
writeFileSync(join(root, ".motion/project.json"), JSON.stringify({ masters: ["out/master.mp4"], render: "render.sh" }));
async function run(command: string, cwd = root): Promise<string> {
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
  return (await motionHook("claude-code", payload, normalizeEvent("claude-code", payload), { cwd, home, now: 1 })).stdout;
}
test("19 earlier master destination is independent of later cd", async () => {
  expect(await run("cp /tmp/a out/master.mp4 && cd /tmp")).toContain("Cannot approve");
  expect(await run("cd /tmp && cp /tmp/a out/master.mp4")).toBe("");
});
test("canonical store aliases and contract writes respect each segment cwd", async () => {
  expect(await run("echo x > alias/motion/K/approvals.json && cd /tmp", home)).toContain("self-approval");
  expect(await run("cd .. && echo x > alias/motion/K/approvals.json && cd /tmp")).toContain("self-approval");
  expect(await run("rm .motion/project.json && cd /tmp")).toContain("contract guard");
});
test("22 initial project discovery exception fails closed only for protected cwd", async () => {
  const spy = spyOn(projectModule, "commandMotionProject").mockImplementation(() => { throw new Error("early discovery failure"); });
  try {
    expect(await run("./render.sh master")).toContain("protected decision failed");
    expect(await run("echo x > alias/motion/K/approvals.json", home)).toContain("protected decision failed");
    expect(await run("cat alias/video-motion/keys/a.key", home)).toContain("protected decision failed");
    expect(await run("git status", home)).toBe("");
  } finally { spy.mockRestore(); }
});
test("archive synonyms cannot replace keys but project extraction remains legitimate", () => {
  for (const command of [`bsdtar -xf a.tar -C${home}`, `gtar -xf a.tar --directory=${home}`, "cd ~ && bsdtar -xf a.tar"]) {
    expect(motionKeyViolation(normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } }), root, home)?.kind).toBe("block");
  }
  expect(motionKeyViolation(normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command: "bsdtar -xf a.tar" } }), root, home)).toBeNull();
});

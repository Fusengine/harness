import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionKeyViolation } from "../src/policy/motion/guard-key";
import { commandMotionProject } from "../src/policy/motion/project-command";
import { normalizeEvent } from "../src/runtime/normalize";
import { motionHook } from "../src/runtime/motion";
import { classifyMotionCommand } from "../src/policy/motion/command";
import { projectContractViolation } from "../src/policy/motion/project-guard";
import { artifactMutationViolation } from "../src/policy/motion/guard-artifact";
import { writeJsonObject, projectStoreDir } from "../src/policy/motion/store";

const home = realpathSync(mkdtempSync(join(tmpdir(), "motion-runtime3-")));
const root = join(home, "video");
mkdirSync(join(root, ".motion"), { recursive: true });
writeFileSync(join(root, ".motion/project.json"), JSON.stringify({ render: "render.sh", masters: ["out/master.mp4"] }));
const keyDir = join(home, ".fuse-harness/video-motion/keys");
mkdirSync(keyDir, { recursive: true });
symlinkSync(keyDir, join(home, "alias"));
test("HMAC key native reads, writes, globs and aliases denied; store reads allowed", () => {
  for (const tool of ["Read", "Grep", "Glob", "read_file", "search_files", "glob", "Write", "apply_patch"]) {
    for (const path of [join(keyDir, "a.key"), join(home, "alias/a.key"), "~/.fuse-harness/video-motion/keys/*"]) {
      const event = normalizeEvent("claude-code", { tool_name: tool, tool_input: { path } });
      expect(motionKeyViolation(event, root, home)?.kind).toBe("block");
    }
  }
  for (const tool of ["Grep", "Glob", "search_files"]) {
    expect(motionKeyViolation(normalizeEvent("claude-code", { tool_name: tool, tool_input: { path: join(home, ".fuse-harness"), pattern: "." } }), root, home)?.kind).toBe("block");
  }
  for (const command of ["cd ~ && tar -xf evil.tar", `tar -xf evil.tar -C ${home}`, "cd ~ && unzip evil.zip", "rg . ~/.fuse-harness", "cp -R ~/.fuse-harness /tmp/copy"]) {
    expect(motionKeyViolation(normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } }), root, home)?.kind).toBe("block");
  }
  for (const command of ["cat ~/.fuse-harness/video-motion/keys/a.key", "cat ~/.fuse-harness/*/*.key", "a=.fuse-har; b=ness; cat ~/$a$b/video-motion/keys/*", `cat ${home}/alias/a.key`]) {
    const event = normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } });
    expect(motionKeyViolation(event, root, home)?.kind).toBe("block");
  }
  for (const command of ["cat ~/.fuse-harness/video-motion/K/approvals.json", "ls ~/.fuse-harness/video-motion", "jq . ~/.fuse-harness/video-motion/K/approvals.json"]) {
    expect(motionKeyViolation(normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } }), root, home)).toBeNull();
  }
});
test("tool writes to declared master require G2 but clean source writes remain allowed", async () => {
  for (const file of ["out/master.mp4", "src/clean.ts"]) {
    const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, file), content: "clean" } };
    const output = (await motionHook("claude-code", payload, normalizeEvent("claude-code", payload), { cwd: root, home, now: 1 })).stdout;
    expect(output.includes("Cannot approve")).toBe(file.includes("master"));
  }
});
test("14 child project resolved through script and cd", async () => {
  for (const command of ["bash video/render.sh --stage master", "cd video && ./render.sh master"]) {
    expect(commandMotionProject(command, home, home)?.root).toBe(root);
    const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
    expect((await motionHook("claude-code", payload, normalizeEvent("claude-code", payload), { cwd: home, home, now: 1 })).stdout).toContain("Cannot approve");
  }
});
test("22 protected pre exceptions deny while unrelated events remain fail-open", async () => {
  const payload = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "src/x.ts"), content: "ok" } };
  const event = normalizeEvent("claude-code", payload);
  Object.defineProperty(event.input, "content", { enumerable: true, get() { throw new Error("injected failure"); } });
  expect((await motionHook("claude-code", payload, event, { cwd: root, home, now: 1 })).stdout).toContain("protected decision failed");
  expect((await motionHook("claude-code", payload, event, { cwd: home, home, now: 1 })).stdout).toBe("");
});
test("15 approved artifacts cannot be removed and replaced by FIFO", () => {
  const project = commandMotionProject("./render.sh", root, home)!;
  writeJsonObject(join(projectStoreDir(root, home), "approvals.json"), { approvals: [{ artifact: project.contact }] });
  expect(artifactMutationViolation("rm .motion/stills/contact.png && mkfifo .motion/stills/contact.png", project, root, home)?.kind).toBe("block");
  expect(artifactMutationViolation("rm /tmp/unrelated.mp4", project, root, home)).toBeNull();
});
test("8 120k targets never spread into arguments", () => {
  const project = commandMotionProject("./render.sh", root, home)!;
  expect(() => classifyMotionCommand(`cp ${"a ".repeat(120000)} out/master.mp4`, root, project)).not.toThrow();
  const event = normalizeEvent("codex", { tool_name: "apply_patch", tool_input: { command: "*** Add File: harmless\n".repeat(120000) } });
  expect(() => projectContractViolation(event, root, home)).not.toThrow();
});

import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfApprovalViolation } from "../src/policy/motion/self-approval";
import { projectContractViolation } from "../src/policy/motion/project-guard";
import { normalizeEvent } from "../src/runtime/normalize";

const root = mkdtempSync(join(tmpdir(), "motion-guard3-"));
mkdirSync(join(root, ".motion"));
mkdirSync(join(root, ".fuse-harness", "video-motion"), { recursive: true });
symlinkSync(join(root, ".fuse-harness"), join(root, "alias"));
test("2 store alias paths are canonicalized", () => {
  expect(selfApprovalViolation("Write", join(root, "alias/motion/K/approvals.json"), undefined)).not.toBeNull();
});
test("16/17 contract mutations include find and replacement tools", () => {
  for (const command of ["find .motion -delete", "find . -name .motion -exec rm -rf {} +", "ln -sf /tmp/evil.json .motion/project.json", "git checkout HEAD~3 -- .motion/project.json", "git restore .motion/project.json", "git stash"]) {
    const event = normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } });
    expect(projectContractViolation(event, root, "/nonhome")).not.toBeNull();
  }
});

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildApexInstruction } from "../src/policy/claude-md-context";
import { buildApexTaskContext, buildApexTaskInjection, loadApexTaskState } from "../src/policy/apex-task-context";
import { apexAgentSteps, apexTaskSteps } from "../src/policy/apex-target-steps";
import { injectApexSubagentContext } from "../src/runtime/lifecycle/aipilot/inject-apex";
import { syncTaskTracking } from "../src/runtime/lifecycle/aipilot/sync-task";

const FALSE_CLAIMS = /TaskList|TaskUpdate|TaskCreate|auto-commit|create it yourself/;

test("default step tables carry no TaskList/TaskUpdate/auto-commit", () => {
  for (const s of [...Object.values(apexTaskSteps("claude-code")), ...Object.values(apexAgentSteps("claude-code"))]) {
    expect(s).not.toMatch(FALSE_CLAIMS);
  }
});

test("claude preamble: tool-neutral plan step, tracking file is harness-managed read-only", () => {
  const out = buildApexInstruction("generic", 100);
  expect(out).not.toMatch(FALSE_CLAIMS);
  expect(out).toContain("`.claude/apex/` is harness-managed and read-only for agents");
  expect(out).toContain("(<100 lines per file)");
});

test("codex keeps its real update_plan tool", () => {
  const out = buildApexInstruction("generic", 100, "codex");
  expect(out).toContain("Use update_plan to break down tasks (<100 lines per file)");
  expect(out).toContain("`.codex/apex/` is harness-managed and read-only for agents");
});

test("task context for claude-code has no false tool/auto-commit claims", () => {
  expect(buildApexTaskContext({ id: "2", subject: "x", phase: "plan", docs: "none" }, 100)).not.toMatch(FALSE_CLAIMS);
});

test("apex dir without/with unusable task.json: injection kept, no fabricated Task line", () => {
  const d = mkdtempSync(join(tmpdir(), "fh-a4-"));
  try {
    expect(loadApexTaskState(join(d, "nope.json"))).toBeNull();
    mkdirSync(join(d, ".claude", "apex"), { recursive: true });
    for (const body of [null, "{ broken", "{}"]) {
      if (body !== null) writeFileSync(join(d, ".claude", "apex", "task.json"), body);
      const out = buildApexTaskInjection(d) ?? "";
      expect(out).toContain("APEX MODE");
      expect(out).toContain("Apply SOLID");
      expect(out).not.toContain("Current:");
      expect(out).not.toContain("Docs consulted");
      expect(out).not.toMatch(/Task #/);
    }
    writeFileSync(join(d, ".claude", "apex", "task.json"), JSON.stringify({ current_task: "1", tasks: { "1": { subject: "s" } } }));
    expect(buildApexTaskInjection(d)).toContain("Task #1 - s");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("sub-agent injection has no TaskUpdate/auto-commit claim", async () => {
  const d = mkdtempSync(join(tmpdir(), "fh-a4-"));
  try {
    mkdirSync(join(d, ".claude", "apex"), { recursive: true });
    const prev = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const out = await injectApexSubagentContext(d, undefined, "claude-code");
      expect(out).toContain("APEX Sub-Agent Instructions");
      expect(out).not.toMatch(/TaskUpdate|auto-commit/);
    } finally {
      if (prev !== undefined) process.env.CLAUDE_PROJECT_DIR = prev;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("syncTaskTracking completed + git changes: WIP-commit reminder via agent, commit only", async () => {
  const d = mkdtempSync(join(tmpdir(), "fh-a4-"));
  const prev = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    spawnSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, "a.txt"), "x");
    mkdirSync(join(d, ".claude", "apex"), { recursive: true });
    writeFileSync(join(d, ".claude", "apex", "task.json"), JSON.stringify({ current_task: "1", tasks: { "1": { subject: "do it", status: "in_progress" } } }));
    const out = await syncTaskTracking({ tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "completed" } }, d);
    const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Task #1 completed: do it");
    expect(ctx).toContain("fuse-ai-pilot:commit");
    expect(ctx).toContain("WIP");
    expect(ctx).toMatch(/no push|commit only/i);
    expect(ctx).not.toContain("/fuse-commit-pro:commit");
    expect(ctx).not.toContain("MANDATORY");
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PROJECT_DIR = prev;
    rmSync(d, { recursive: true, force: true });
  }
});

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectClaudeMdProjectType,
  DEV_VERBS,
} from "../src/policy/claude-md-context";
import {
  buildApexTaskContext,
  buildApexTaskInjection,
  loadApexTaskState,
} from "../src/policy/apex-task-context";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

const root = (): string => mkdtempSync(join(tmpdir(), "fh-ic-"));

test("DEV_VERBS matches FR/EN dev verbs case-insensitively", () => {
  expect(DEV_VERBS.test("Créer un module")).toBe(true);
  expect(DEV_VERBS.test("please IMPLEMENT this")).toBe(true);
  expect(DEV_VERBS.test("refactor the gate")).toBe(true);
  expect(DEV_VERBS.test("what is the weather")).toBe(false);
});

test("detectClaudeMdProjectType: package.json next/react then generic", () => {
  const prevDir = process.env.CLAUDE_PROJECT_DIR; // detection now follows CLAUDE_PROJECT_DIR
  delete process.env.CLAUDE_PROJECT_DIR;
  try { detectCases(); } finally { if (prevDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevDir; }
});

function detectCases(): void {
  const a = root();
  writeFileSync(join(a, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
  expect(detectClaudeMdProjectType(a)).toBe("nextjs");
  const b = root();
  writeFileSync(join(b, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
  expect(detectClaudeMdProjectType(b)).toBe("react");
  const c = root();
  writeFileSync(join(c, "composer.json"), "{}");
  writeFileSync(join(c, "artisan"), "#!/usr/bin/env php");
  expect(detectClaudeMdProjectType(c)).toBe("laravel");
  expect(detectClaudeMdProjectType(root())).toBe("generic");
}

test("loadApexTaskState: parses + defaults on missing", () => {
  const dir = root();
  const f = join(dir, "task.json");
  const tasks = { "3": { subject: "wire", phase: "execute", doc_consulted: { ctx7: { consulted: true }, exa: { consulted: false } } } };
  writeFileSync(f, JSON.stringify({ current_task: "3", tasks }));
  expect(loadApexTaskState(f)).toEqual({ id: "3", subject: "wire", phase: "execute", docs: "ctx7" });
  // A4: no fake "Task #1" fallback — an unreadable task.json yields no state.
  expect(loadApexTaskState(join(dir, "nope.json"))).toBeNull();
});

test("buildApexTaskContext: exact injection text", () => {
  const out = buildApexTaskContext({ id: "2", subject: "x", phase: "plan", docs: "none" }, 100);
  expect(out.startsWith("⚠️ APEX MODE - Read .claude/apex/AGENTS.md for rules")).toBe(true);
  expect(out).toContain("Current: Task #2 - x (Phase: plan)");
  expect(out).toContain("Docs consulted: none");
  expect(out).toContain("5. Apply SOLID (files < 100 lines)");
  // A4: no TaskUpdate/auto-commit claim (was "7. TaskUpdate(completed) → triggers auto-commit").
  expect(out.endsWith("7. Report completion to the lead (do not commit unless the brief says so)")).toBe(true);
});

test("buildApexTaskInjection: null without .claude/apex, text with it", () => {
  const a = root();
  expect(buildApexTaskInjection(a)).toBeNull();
  const b = root();
  mkdirSync(join(b, ".claude", "apex"), { recursive: true });
  expect(buildApexTaskInjection(b)).toContain("APEX MODE");
});

test("handleHook: PreToolUse Task injects APEX context when apex dir exists", async () => {
  const cwd = root();
  mkdirSync(join(cwd, ".claude", "apex"), { recursive: true });
  // Pin CLAUDE_PROJECT_DIR for the call, restored in `finally` — other test
  // files leave it set process-wide otherwise (see test/mcp-tool-name.test.ts
  // for the same pattern), which previously leaked into later, unrelated
  // tests sharing the same `bun test` process.
  const prevProjDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  try {
    const opts: HandleOptions = { now: 1000, cwd };
    const payload = { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Task", tool_input: { subagent_type: "x" } };
    const out = await handleHook("claude-code", payload, opts);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("APEX MODE");
  } finally {
    if (prevProjDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjDir;
  }
});

test("handleHook: PreToolUse Task stays silent without apex dir", async () => {
  const cwd = root();
  const prevProjDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = cwd;
  try {
    const opts: HandleOptions = { now: 1000, cwd };
    const payload = { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Task", tool_input: { subagent_type: "x" } };
    expect((await handleHook("claude-code", payload, opts)).stdout).toBe("");
  } finally {
    if (prevProjDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjDir;
  }
});

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { sessionLessonOnce } from "../src/runtime/inject-session/lesson-once";
import { contextResponse } from "../src/adapters/claude";

const dirs: string[] = [];
const savedEnv = { root: process.env.CLAUDE_PLUGIN_ROOT, proj: process.env.CLAUDE_PROJECT_DIR };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv.root === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = savedEnv.root;
  if (savedEnv.proj === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedEnv.proj;
});
/** Scratch dir. */
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "inject-session-handle-"));
  dirs.push(d);
  return d;
}
/** Distinct paragraphs totalling ~`n` chars. */
function rulesBody(n: number): string {
  const out: string[] = [];
  for (let i = 0; out.join("\n\n").length < n; i++) out.push(`RULE-${i} ${"r".repeat(400)}`);
  return out.join("\n\n");
}
let home = "";
let project = "";
beforeEach(() => {
  home = tmp();
  project = tmp();
  const root = tmp();
  mkdirSync(join(root, "rules"));
  writeFileSync(join(root, "rules", "00-big.md"), rulesBody(30_000));
  process.env.CLAUDE_PLUGIN_ROOT = root;
  process.env.CLAUDE_PROJECT_DIR = project;
});
/** Run a rules-scope hook on the given host. */
async function run(id: string, event: string, extra: Record<string, unknown> = {}, now = 1_000_000): Promise<string> {
  const payload = { hook_event_name: event, session_id: "sess-A", prompt: "hello", cwd: project, ...extra };
  return (await handleHook(id, payload, { now, cwd: project, scope: "rules", home })).stdout;
}
/** additionalContext of a stdout ("" when none). */
function ctx(stdout: string): string {
  return stdout ? ((JSON.parse(stdout).hookSpecificOutput?.additionalContext as string | undefined) ?? "") : "";
}

describe("Claude Code: rules block delivered once, in full, in chunks", () => {
  test("30 KB rules: every field < 10 000 chars, full content over successive prompts, then the 2 000-char recall on every prompt", async () => {
    const got: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = ctx(await run("claude-code", "UserPromptSubmit", { prompt: `p${i}` }, 1_000_000 + i * 10_000));
      expect(c.length).toBeLessThan(10_000);
      expect(c.startsWith("RULE-0 ")).toBe(true); // HEAD's visible head is recalled on EVERY prompt
      got.push(c);
    }
    const all = got.join("\n\n");
    expect(got.filter((c) => c.length > 2000).length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 60; i++) expect(all).toContain(`RULE-${i} `);
    const later = ctx(await run("claude-code", "UserPromptSubmit", { prompt: "later" }, 2_000_000));
    expect(later.length).toBe(2000);
  });
  test("compact / clear resets the registry: everything is delivered again", async () => {
    for (let i = 0; i < 6; i++) await run("claude-code", "UserPromptSubmit", { prompt: `p${i}` }, 1_000_000 + i * 10_000);
    expect(ctx(await run("claude-code", "UserPromptSubmit", { prompt: "x" }, 1_100_000)).length).toBe(2000);
    const first = ctx(await run("claude-code", "SessionStart", { source: "compact" }, 2_000_000));
    expect(first).toContain("RULE-0 ");
  });
  test("sub-agent (own agent_id) receives the full set once, independent of the parent session", async () => {
    for (let i = 0; i < 6; i++) await run("claude-code", "UserPromptSubmit", {}, 1_000_000 + i);
    const sub = ctx(await run("claude-code", "SubagentStart", { agent_id: "ag1", agent_type: "x" }, 1_200_000));
    expect(sub).toContain("RULE-0 ");
    expect(ctx(await run("claude-code", "SubagentStart", { agent_id: "ag1", agent_type: "x" }, 1_200_100))).not.toContain("RULE-0 ");
    expect(ctx(await run("claude-code", "SubagentStart", { agent_id: "ag2", agent_type: "x" }, 1_200_200))).toContain("RULE-0 ");
  });
  test("sub-agent tool events drain the parked rest of the block (no cap loss)", async () => {
    const parts = [ctx(await run("claude-code", "SubagentStart", { agent_id: "ag9" }, 1_300_000))];
    for (let i = 0; i < 6; i++) {
      const out = await handleHook("claude-code", { hook_event_name: "PostToolUse", session_id: "sess-A", agent_id: "ag9", tool_name: "Read", tool_input: { file_path: "/nope" }, cwd: project }, { now: 1_300_001 + i, cwd: project, home });
      parts.push(ctx(out.stdout));
    }
    const all = parts.join("\n\n");
    expect(parts.every((p) => p.length < 10_000)).toBe(true);
    for (let i = 0; i < 60; i++) expect(all).toContain(`RULE-${i} `);
  });
});

describe("other hosts are untouched", () => {
  test.each(["codex", "kimi", "gemini", "cursor"])("%s: identical output on every repeat (no session registry)", async (id) => {
    const ev = id === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit";
    const a = await run(id, ev, { conversation_id: "c1" }, 1);
    const b = await run(id, ev, { conversation_id: "c1" }, 2);
    expect(b).toBe(a);
  });
});

describe("filterClaudeContext", () => {
  const base = (): { stateDir: string; home: string; scope: string } => ({ stateDir: tmp(), home: tmp(), scope: "core" });
  test("decisions and unrelated events are returned byte-identical", () => {
    const b = base();
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
    expect(filterClaudeContext(deny, { ...b, now: 1, payload: { hook_event_name: "PreToolUse", session_id: "s" } })).toBe(deny);
    const stop = contextResponse("Stop", "x");
    expect(filterClaudeContext(stop, { ...b, now: 1, payload: { hook_event_name: "Stop", session_id: "s" } })).toBe(stop);
    expect(filterClaudeContext("not json", { ...b, now: 1, payload: { hook_event_name: "SessionStart", session_id: "s" } })).toBe("not json");
  });
  test("first delivery is the unchanged stdout; the repeat keeps the systemMessage but drops the context", () => {
    const b = base();
    const out = JSON.stringify({ systemMessage: "notice", hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "BODY ".repeat(50) } });
    const p = { hook_event_name: "SubagentStart", session_id: "s", agent_id: "a1" };
    expect(filterClaudeContext(out, { ...b, now: 1, payload: p })).toBe(out);
    expect(JSON.parse(filterClaudeContext(out, { ...b, now: 2, payload: p }))).toEqual({ systemMessage: "notice" });
  });
  test("the natively-loaded ~/.claude/CLAUDE.md body is not re-injected at SessionStart, but IS recalled on every prompt", () => {
    const b = base();
    mkdirSync(join(b.home, ".claude"), { recursive: true });
    const doc = "OWNER-DOC ".repeat(30);
    writeFileSync(join(b.home, ".claude", "CLAUDE.md"), doc);
    const apex = "INSTRUCTION: use APEX.";
    const start = contextResponse("SessionStart", `${apex}\n\n${doc}`);
    expect(ctx(filterClaudeContext(start, { ...b, now: 1, payload: { hook_event_name: "SessionStart", session_id: "s" } }))).toBe(apex);
    const ups = contextResponse("UserPromptSubmit", `${apex}\n\n# CLAUDE.md\n${doc}`);
    for (let i = 0; i < 3; i++) {
      const c = ctx(filterClaudeContext(ups, { ...b, now: 100_000 * (i + 1), payload: { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: `p${i}` } }));
      expect(c).toContain(doc);
    }
  });
  test("SubagentStart without agent_id is passed through untouched", () => {
    const b = base();
    const out = contextResponse("SubagentStart", "Z".repeat(100));
    expect(filterClaudeContext(out, { ...b, now: 1, payload: { hook_event_name: "SubagentStart", session_id: "s" } })).toBe(out);
  });
});

describe("PreToolUse lesson note cooldown", () => {
  test("once per session+lesson, again for another session or sub-agent", () => {
    const cwd = tmp();
    const h = tmp();
    const a = sessionLessonOnce("sess-1", "", cwd, h);
    expect(a("lesson:abc", 1800000)).toBe(true);
    expect(a("lesson:abc", 1800000)).toBe(false);
    expect(a("lesson:other", 1800000)).toBe(true);
    expect(sessionLessonOnce("sess-2", "", cwd, h)("lesson:abc", 1800000)).toBe(true);
    expect(sessionLessonOnce("sess-1", "agent-x", cwd, h)("lesson:abc", 1800000)).toBe(true);
  });
  test("survives short-window dedup traffic (the root cause of 741 repeats)", async () => {
    const cwd = tmp();
    const h = tmp();
    const once = sessionLessonOnce("sess-3", "", cwd, h);
    expect(once("lesson:z", 1800000)).toBe(true);
    const { oncePerWindow } = await import("../src/runtime/inject-dedup");
    oncePerWindow("claude-md:x", 3000, { now: Date.now() + 10_000, dir: tmp() });
    expect(sessionLessonOnce("sess-3", "", cwd, h)("lesson:z", 1800000)).toBe(false);
  });
});

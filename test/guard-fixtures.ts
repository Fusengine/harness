import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "bun:test";
import { trackAgentMemory } from "../src/runtime/lifecycle/agent-memory";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";

/** Fixed clock base shared by the report-recovery tests. */
export const T = 1_000_000_000_000;
/** A realistic sub-agent final report. */
export const REPORT = "Done: 3 files changed.\n\n| check | result |\n|---|---|\n| tsc | 0 errors |";

/** Every dir created by {@link tmp} / {@link nonTmp}, removed by {@link cleanTestDirs}. */
const created: string[] = [];
const track = (dir: string): string => { created.push(dir); return dir; };

/** A fresh dir under `os.tmpdir()` (a temp area). Call {@link cleanTestDirs} afterwards. */
export const tmp = (): string => track(mkdtempSync(join(tmpdir(), "fh-guard-")));

/** Write `body` to `path` (parents created) and return `path`. */
export const file = (path: string, body = "export const x = 1;\n"): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};

/** A JSONL sub-agent transcript whose only tool uses are Writes of `files`. */
export const transcript = (files: string[]): string =>
  file(join(tmp(), "agent.jsonl"), files.map((f) => JSON.stringify({ message: { content: [{ type: "tool_use", name: "Write", input: { file_path: f } }] } })).join("\n") + "\n");

/** A real-shaped Claude Code session scratchpad dir (`claude-<uid>/<slug>/<uuid>/scratchpad`). */
export const scratchpad = (): string => join(tmp(), "claude-501", "slug", randomUUID(), "scratchpad");

/** A real directory OUTSIDE every temp area (`/var/tmp` is not one): a "normal" project root. Call {@link cleanTestDirs} afterwards. */
export const nonTmp = (): string => track(mkdtempSync(join("/var/tmp", "fh-guard-")));

/** Remove every dir created by {@link tmp} and {@link nonTmp} (call from `afterEach`). */
export const cleanTestDirs = (): void => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** A sub-agent transcript like Claude Code writes it: one JSONL entry per block, `type`/`uuid`/`message.content`. */
export function agentTranscript(agentId: string, texts: string[]): string {
  const path = join(tmp(), "subagents", `agent-${agentId}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, texts.map((text, i) => JSON.stringify({ type: "assistant", uuid: `u-${i}`, agentId, message: { content: [{ type: "text", text }] } })).join("\n") + "\n");
  return path;
}

/** Drive a guarded SubagentStop: the agent wrote project code, so the sniper demand is emitted (and recorded). `at` = clock, `active` = `stop_hook_active`. */
export function guardedStop(root: string, home: string, agentId: string, transcript: string, lastMessage: string = REPORT, at: number = T, active = false): string {
  const src = join(root, "src", `${agentId}.ts`); // one file per agent: demanded once per agent unless re-edited later
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(src, `export const a = ${at};\n`);
  trackSessionChanges("s", src, home, at, { agentId, cwd: root });
  const out = trackAgentMemory({ session_id: "s", cwd: root, agent_id: agentId, agent_type: "fuse-typescript:typescript-expert", stop_hook_active: active, agent_transcript_path: transcript, last_assistant_message: lastMessage }, home, at);
  expect(out).toContain("SNIPER VALIDATION REQUIRED");
  return out;
}

/** The parent's PostToolUse payload for a finished foreground Agent call. */
export const agentResult = (agentId: string, text: string): Record<string, unknown> => ({
  session_id: "s",
  tool_name: "Agent",
  tool_response: { status: "completed", agentId, content: [{ type: "text", text }] },
});

/** `additionalContext` of a Claude PostToolUse stdout. */
export const contextOf = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

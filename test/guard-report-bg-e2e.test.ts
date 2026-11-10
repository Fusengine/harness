import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fusengineCache } from "../src/runtime/home-state";
import { RECOVERED_LABEL } from "../src/runtime/lifecycle/report-recovery";
import { HOOK_OUTPUT_CAP } from "../src/runtime/lifecycle/report-background";
import { REPORT, T, agentResult, agentTranscript, cleanTestDirs, contextOf, guardedStop, tmp } from "./guard-fixtures";
import { notification } from "./guard-notification";
import { recoveredReportContext } from "../src/runtime/lifecycle/report-recovery";
import { trackAgentMemory } from "../src/runtime/lifecycle/agent-memory";

const BIN = join(import.meta.dir, "../src/cli/bin.ts");
let root = "";
let prevProjectDir: string | undefined;
beforeEach(() => { prevProjectDir = process.env.CLAUDE_PROJECT_DIR; root = tmp(); process.env.CLAUDE_PROJECT_DIR = root; });
afterEach(() => { if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProjectDir; cleanTestDirs(); });

const envOf = (home: string): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: home, CLAUDE_PROJECT_DIR: root, FUSE_HARNESS_RENDEZVOUS: "0" });
const run = (home: string, sid: string, payload: Record<string, unknown>): string =>
  spawnSync("bun", [BIN, "hook", "claude-code", "core"], { cwd: root, input: JSON.stringify({ session_id: sid, cwd: root, ...payload }), encoding: "utf8", env: envOf(home) }).stdout;

/** Agent `id` writes a project file (PostToolUse tag), then stops: the guard fires and is recorded. */
function guardedViaHooks(home: string, sid: string, id: string, transcript: string, last: string): string {
  const src = join(root, "src", `${id}.ts`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(src, "export const e = 1;\n");
  run(home, sid, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: src, content: "x" }, tool_response: { type: "create", filePath: src }, agent_id: id, agent_type: "general-purpose" });
  return run(home, sid, { hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: id, agent_type: "general-purpose", agent_transcript_path: transcript, last_assistant_message: last });
}

test("real CLAUDE.md-sized injection: main's UserPromptSubmit payload is a byte-identical prefix; the report is only appended, within the cap", () => {
  /** A fresh HOME holding an owner CLAUDE.md of `lines` rule lines (≈ 60 chars each). */
  const homeWithClaudeMd = (lines: number): string => {
    const h = tmp();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", "CLAUDE.md"), `# Owner rules MARKER-CLAUDE-MD\n${"- a realistic rule line that the owner wrote, keep it in full\n".repeat(lines)}`);
    return h;
  };
  let appendedCases = 0;
  for (const [lines, size] of [[140, 0], [140, 3000], [60, 7000], [60, 12000], [140, 7000]] as const) {
    const report = size === 0 ? REPORT : `## Final report\n${"detail line of the report\n".repeat(Math.ceil(size / 26))}END`;
    const id = `bud${lines}x${size}`;
    const prompt = notification(id, "Understood.");
    // Same prompt, same CLAUDE.md, but the agent has no record in a separate HOME = exactly what main injects.
    const baseline = contextOf(run(homeWithClaudeMd(lines), "base", { hook_event_name: "UserPromptSubmit", prompt }));
    expect(baseline).toContain("MARKER-CLAUDE-MD");
    const home = homeWithClaudeMd(lines);
    const transcript = agentTranscript(id, [report, "Understood."]);
    expect(guardedViaHooks(home, "g", id, transcript, report)).toContain("SNIPER VALIDATION REQUIRED");
    const ctx = contextOf(run(home, "g", { hook_event_name: "UserPromptSubmit", prompt }));
    expect(ctx.startsWith(baseline)).toBe(true); // nothing displaced, reordered or shrunk
    const appended = ctx.slice(baseline.length);
    expect(ctx.length).toBeLessThanOrEqual(Math.max(HOOK_OUTPUT_CAP, baseline.length));
    if (appended === "") continue; // no room left under the cap: nothing partial is injected
    appendedCases++;
    expect(appended.startsWith("\n\n" + RECOVERED_LABEL + "\n")).toBe(true);
    const body = appended.slice(2);
    if (body === `${RECOVERED_LABEL}\n${report}`) continue; // whole, byte-identical (`\n` untouched)
    expect(body).toContain("truncated");
    expect(body.endsWith(`${transcript}]`)).toBe(true);
    expect(appended.split(RECOVERED_LABEL).length).toBe(2); // never duplicated
  }
  expect(appendedCases).toBeGreaterThanOrEqual(3);
});

test("concurrent SubagentStop runs of several agents of one session lose no record", async () => {
  const home = tmp();
  const ids = Array.from({ length: 8 }, (_, i) => `cc${i}`);
  const stops = ids.map((id) => {
    const src = join(root, "src", `${id}.ts`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(src, "export const e = 1;\n");
    run(home, "conc", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: src, content: "x" }, tool_response: { type: "create", filePath: src }, agent_id: id, agent_type: "general-purpose" });
    return { id, transcript: agentTranscript(id, [`report of ${id}`, "ack"]) };
  });
  await Promise.all(stops.map(({ id, transcript }) => new Promise<void>((resolve) => {
    const child = spawn("bun", [BIN, "hook", "claude-code", "core"], { cwd: root, env: envOf(home), stdio: ["pipe", "ignore", "ignore"] });
    child.on("close", () => resolve());
    child.stdin.end(JSON.stringify({ session_id: "conc", cwd: root, hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: id, agent_type: "general-purpose", agent_transcript_path: transcript, last_assistant_message: `report of ${id}` }));
  })));
  const files = readdirSync(join(fusengineCache(home), "guard-reports")).filter((n) => n.endsWith(".json"));
  expect(files.sort()).toEqual(ids.map((id) => `conc.${id}.json`).sort());
  for (const { id } of stops) expect(contextOf(run(home, "conc", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "p" }, tool_response: { status: "completed", agentId: id, content: [{ type: "text", text: "ack" }] } }))).toBe(`${RECOVERED_LABEL}\nreport of ${id}`);
});

test("stale record: a fresh unguarded stop of the agent deletes its record; a continuation keeps it", () => {
  const home = tmp();
  guardedStop(root, home, "st1", agentTranscript("st1", [REPORT, "ack"]));
  // continuation after the guard (stop_hook_active true): the agent's answer must not drop the record
  trackAgentMemory({ session_id: "s", cwd: root, agent_id: "st1", agent_type: "fuse-typescript:typescript-expert", stop_hook_active: true, last_assistant_message: "ack" }, home, T + 1000);
  expect(recoveredReportContext(agentResult("st1", "ack"), home)).not.toBe("");
  // a relaunch whose first stop is NOT guarded: the previous run's record is gone
  guardedStop(root, home, "st2", agentTranscript("st2", [REPORT, "ack"]));
  trackAgentMemory({ session_id: "s", cwd: root, agent_id: "st2", agent_type: "fuse-typescript:typescript-expert", stop_hook_active: false, last_assistant_message: "second run" }, home, T + 2000);
  expect(recoveredReportContext(agentResult("st2", "second run"), home)).toBe("");
});

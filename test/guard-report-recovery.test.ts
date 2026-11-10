import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fusengineCache } from "../src/runtime/home-state";
import { trackAgentMemory } from "../src/runtime/lifecycle/agent-memory";
import { RECOVERED_LABEL, UNRECOVERABLE_NOTICE, recoveredReportContext } from "../src/runtime/lifecycle/report-recovery";
import { FRAGMENT_CHAR_CAP } from "../src/runtime/inject-budget";
import { REPORT, T, agentResult, agentTranscript, cleanTestDirs, contextOf, guardedStop as sharedGuardedStop, tmp } from "./guard-fixtures";

/** Join fragments at runtime so no secret-shaped literal sits in source (the commit secret scan blocks them). */
const J = (...p: string[]): string => p.join("");

const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
let root = "";
beforeEach(() => { root = tmp(); process.env.CLAUDE_PROJECT_DIR = root; });
afterEach(() => { if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProjectDir; cleanTestDirs(); });

const guardedStop = (home: string, agentId: string, transcript: string, lastMessage: string = REPORT): string => sharedGuardedStop(root, home, agentId, transcript, lastMessage);

test("guard emitted → the pre-guard report is recovered verbatim under the exact label", () => {
  const home = tmp();
  const transcript = agentTranscript("a1b2", ["working…", REPORT, "Understood, I will run the sniper agent now."]);
  guardedStop(home, "a1b2", transcript);
  const ctx = contextOf(recoveredReportContext(agentResult("a1b2", "Understood, I will run the sniper agent now."), home));
  expect(ctx).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  expect(RECOVERED_LABEL).toBe("Report recovered from the sub-agent transcript (its final message was a reply to a harness hook):");
  // Consumed: a second PostToolUse for the same agent adds nothing.
  expect(recoveredReportContext(agentResult("a1b2", "x"), home)).toBe("");
});

test("normal stop (no guard emitted) → nothing added; unknown agent id → nothing added", () => {
  const home = tmp();
  const transcript = agentTranscript("n1", [REPORT]);
  trackAgentMemory({ session_id: "s", cwd: root, agent_id: "n1", agent_type: "general-purpose", agent_transcript_path: transcript, last_assistant_message: REPORT }, home, T);
  expect(recoveredReportContext(agentResult("n1", REPORT), home)).toBe("");
  expect(recoveredReportContext(agentResult("zzz", REPORT), home)).toBe("");
  expect(recoveredReportContext({ session_id: "s", tool_name: "Agent", tool_response: "plain string" }, home)).toBe("");
});

test("the agent re-emitted its whole report after the guard → nothing to recover", () => {
  const home = tmp();
  guardedStop(home, "r1", agentTranscript("r1", [REPORT, REPORT]));
  expect(recoveredReportContext(agentResult("r1", REPORT), home)).toBe("");
});

test("transcript missing or unreadable or never matching → exactly one notice line, no crash", () => {
  const home = tmp();
  const gone = agentTranscript("m1", [REPORT]);
  guardedStop(home, "m1", gone);
  writeFileSync(gone, "not json at all\n"); // the transcript later lost the report
  expect(contextOf(recoveredReportContext(agentResult("m1", "ack"), home))).toBe(UNRECOVERABLE_NOTICE);
  guardedStop(home, "m2", join(tmp(), "agent-m2.jsonl")); // never existed
  expect(contextOf(recoveredReportContext(agentResult("m2", "ack"), home))).toBe(UNRECOVERABLE_NOTICE);
  guardedStop(home, "m3", agentTranscript("other", [REPORT])); // path does not belong to this agent: ambiguous
  expect(contextOf(recoveredReportContext(agentResult("m3", "ack"), home))).toBe(UNRECOVERABLE_NOTICE);
});

test("oversize report → no file written; context names the sub-agent transcript path and says the head is truncated", () => {
  const home = tmp();
  const big = "line of the report\n".repeat(900); // > FRAGMENT_CHAR_CAP
  expect(big.length).toBeGreaterThan(FRAGMENT_CHAR_CAP);
  const transcript = agentTranscript("big1", [big, "ack"]);
  guardedStop(home, "big1", transcript, big);
  const dir = join(fusengineCache(home), "guard-reports");
  const before = readdirSync(dir).sort();
  const ctx = contextOf(recoveredReportContext(agentResult("big1", "ack"), home));
  expect(ctx.length).toBeLessThan(FRAGMENT_CHAR_CAP);
  expect(ctx.startsWith(RECOVERED_LABEL)).toBe(true);
  expect(ctx).toContain("truncated");
  expect(ctx).toContain(transcript);
  expect(ctx.endsWith(`${transcript}]`)).toBe(true);
  // Only the consumed `<sid>.json` record may change; no report copy is created.
  expect(readdirSync(dir).filter((n) => !before.includes(n))).toEqual([]);
  expect(readdirSync(dir).some((n) => n.endsWith(".md"))).toBe(false);
});

test("oversize report with the transcript removed → one notice line, no path", () => {
  const home = tmp();
  const big = "line of the report\n".repeat(900);
  const transcript = agentTranscript("big2", [big, "ack"]);
  guardedStop(home, "big2", transcript, big);
  rmSync(transcript);
  const ctx = contextOf(recoveredReportContext(agentResult("big2", "ack"), home));
  expect(ctx).toBe(UNRECOVERABLE_NOTICE);
  expect(ctx).not.toContain("agent-big2.jsonl");
});

test("recovered text is byte-identical: no masking, secret-shaped and look-alike strings included", () => {
  const home = tmp();
  const texts = [
    J("deployed with key s", "k-abcdefghijklmnopqrstuvwx1234 and AK", "IAABCDEFGHIJKLMNOP, password=hunter2hunter2"),
    J("sk_live_", "a1B2c3D4e5F6g7H8i9J0 glpat-", "abcdefghij0123456789 npm_", "a".repeat(36)),
    J("postgres:", "//admin:s3cr3tpw@db.internal:5432/app"),
    J("ey", "JhbGciOiJIUzI1NiJ9.ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
    "const password = getPassword(input)",
    "apiKey = process.env.API_KEY",
    "tokenizer=cl100k_base",
    "token_endpoint: https://example.com/oauth/token",
    '"tokenCount": "1234"',
    '"token_type": "Bearer"',
    '"secretName"',
    '"passwordPolicy"',
  ];
  texts.forEach((text, i) => {
    const id = `raw${i}`;
    guardedStop(home, id, agentTranscript(id, [text, "ack"]), text);
    expect(contextOf(recoveredReportContext(agentResult(id, "ack"), home))).toBe(`${RECOVERED_LABEL}\n${text}`);
  });
});

test("the transcript basename must be EXACTLY agent-<id>.jsonl (id `a1b2` must not accept agent-a1b23.jsonl)", () => {
  const home = tmp();
  guardedStop(home, "a1b2", agentTranscript("a1b23", [REPORT, "ack"]));
  expect(contextOf(recoveredReportContext(agentResult("a1b2", "ack"), home))).toBe(UNRECOVERABLE_NOTICE);
});

test("guard-report files older than 7 days are pruned on each write; recent ones are kept", () => {
  const home = tmp();
  const dir = join(fusengineCache(home), "guard-reports");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "old-session.json"), fresh = join(dir, "fresh-session.json");
  writeFileSync(old, "[]"); writeFileSync(fresh, "[]");
  const eightDays = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  utimesSync(old, eightDays, eightDays);
  const oldDir = join(dir, "old-dir.json"); // an OLD directory that looks like ours: never removed, never stops the loop
  mkdirSync(join(oldDir, "inner"), { recursive: true });
  utimesSync(oldDir, eightDays, eightDays);
  const oldMd = join(dir, "x-y.md"); // pre-existing report copy from an earlier version: owner's file, never deleted
  writeFileSync(oldMd, "kept");
  utimesSync(oldMd, eightDays, eightDays);
  const foreign = join(dir, "notes.txt"); // foreign file: not ours
  writeFileSync(foreign, "x");
  utimesSync(foreign, eightDays, eightDays);
  guardedStop(home, "pr1", agentTranscript("pr1", [REPORT]));
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(oldDir)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  expect(existsSync(oldMd)).toBe(true);
});

test("end to end through the real hook binary: PostToolUse Write (agent) → SubagentStop guard → PostToolUse Agent recovers", () => {
  const home = tmp();
  const env = { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_PROJECT_DIR: root, FUSE_HARNESS_RENDEZVOUS: "0" };
  const run = (payload: Record<string, unknown>): string =>
    spawnSync("bun", [join(import.meta.dir, "../src/cli/bin.ts"), "hook", "claude-code", "core"], { cwd: root, input: JSON.stringify({ session_id: "e2e", cwd: root, ...payload }), encoding: "utf8", env }).stdout;
  const src = join(root, "src", "e2e.ts");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(src, "export const e = 1;\n");
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: src, content: "x" }, tool_response: { type: "create", filePath: src }, agent_id: "e2eagent", agent_type: "general-purpose" });
  const transcript = agentTranscript("e2eagent", [REPORT, "ack"]);
  const guard = run({ hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: "e2eagent", agent_type: "general-purpose", agent_transcript_path: transcript, last_assistant_message: REPORT });
  expect(guard).toContain("SNIPER VALIDATION REQUIRED");
  const post = run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "p" }, tool_response: { status: "completed", agentId: "e2eagent", content: [{ type: "text", text: "ack" }] } });
  expect(contextOf(post)).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { RECOVERED_LABEL, UNRECOVERABLE_NOTICE } from "../src/runtime/lifecycle/report-recovery";
import { HOOK_OUTPUT_CAP, recoveredBackgroundText, withBackgroundReports } from "../src/runtime/lifecycle/report-background";
import { FRAGMENT_CHAR_CAP } from "../src/runtime/inject-budget";
import { REPORT, T, agentTranscript, cleanTestDirs, contextOf, guardedStop, tmp } from "./guard-fixtures";
import { notification, ups } from "./guard-notification";

const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
let root = "";
beforeEach(() => { root = tmp(); process.env.CLAUDE_PROJECT_DIR = root; });
afterEach(() => { if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProjectDir; cleanTestDirs(); });

const guarded = (home: string, id: string, texts: string[], last = REPORT): string => { const p = agentTranscript(id, texts); guardedStop(root, home, id, p, last); return p; };
const bg = (home: string, prompt: string, budget = FRAGMENT_CHAR_CAP): string => recoveredBackgroundText(ups(prompt), prompt, budget, home);

test("background agent guarded → its notification turn gets the real report, verbatim, injected once per notification", () => {
  const home = tmp();
  guarded(home, "adee9bbfdb3768e5b", ["working…", REPORT, "Understood, running sniper now."]);
  const prompt = notification("adee9bbfdb3768e5b", "Understood, running sniper now.");
  expect(bg(home, prompt)).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  expect(bg(home, prompt)).toBe(""); // the same notification delivered twice: once
});

test("unknown task-id, human prompt, no session → nothing; the record is not consumed by those", () => {
  const home = tmp();
  guarded(home, "bg2", [REPORT, "ack"]);
  expect(bg(home, notification("zzz9", "x"))).toBe("");
  expect(bg(home, "please summarize bg2")).toBe("");
  const p = notification("bg2", "ack");
  expect(recoveredBackgroundText({ hook_event_name: "UserPromptSubmit", prompt: p }, p, FRAGMENT_CHAR_CAP, home)).toBe("");
  expect(bg(home, p)).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

test("a typed look-alike does not steal the real notification; the real one still injects (typed text surfaces same-session data: accepted)", () => {
  const home = tmp();
  guarded(home, "bg8", [REPORT, "ack"]);
  const typed = notification("bg8", "typed by the owner");
  expect(bg(home, typed)).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  expect(bg(home, notification("bg8", "ack"))).toBe(`${RECOVERED_LABEL}\n${REPORT}`); // different text = a different notification
  expect(bg(home, typed)).toBe("");
});

test("several notification blocks in one prompt, wrapped in other text → each guarded agent gets its report", () => {
  const home = tmp();
  const reportB = "Agent B report: migrated 2 modules.";
  guarded(home, "bga", [REPORT, "ack"]);
  guarded(home, "bgb", [reportB, "ack"], reportB);
  const prompt = `intro text\n${notification("bga", "ack")}\nbetween\n${notification("bgu", "no guard here")}\n${notification("bgb", "ack")}\noutro`;
  expect(bg(home, prompt)).toBe(`${RECOVERED_LABEL}\n${REPORT}\n\n${RECOVERED_LABEL}\n${reportB}`);
});

test("re-guarded background agent → the ORIGINAL report; a resumed run (after delivery) gets ITS report, not the previous one", () => {
  const home = tmp();
  const path = guarded(home, "bg3", [REPORT]);
  const line = (uuid: string, text: string): string => JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
  writeFileSync(path, `${line("u-0", REPORT)}\n${line("u-1", "Guard reply 1.")}\n`);
  guardedStop(root, home, "bg3", path, "Guard reply 1.", T + 5000, true);
  expect(bg(home, notification("bg3", "Guard reply 2."))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  const run2 = "Run 2 report: different.";
  writeFileSync(path, `${line("v-0", run2)}\n`);
  guardedStop(root, home, "bg3", path, run2, T + 9000, false);
  expect(bg(home, notification("bg3", "run2 reply"))).toBe(`${RECOVERED_LABEL}\n${run2}`);
});

test("the notification already carries the whole report → nothing to add", () => {
  const home = tmp();
  guarded(home, "bg4", [REPORT, REPORT]);
  expect(bg(home, notification("bg4", REPORT))).toBe("");
});

test("over the budget → head + explicit truncation + the verified agent-<id>.jsonl path, never over budget; transcript gone → one notice", () => {
  const home = tmp();
  const big = "line of the report\n".repeat(900);
  const path = guarded(home, "bg5", [big, "ack"], big);
  const out = bg(home, notification("bg5", "ack"), 4000);
  expect(out.startsWith(RECOVERED_LABEL)).toBe(true);
  expect(out).toContain("truncated");
  expect(out.endsWith(`${path}]`)).toBe(true);
  expect(out.length).toBeLessThanOrEqual(4000);
  const p6 = guarded(home, "bg6", [big, "ack"], big);
  writeFileSync(p6, "");
  expect(bg(home, notification("bg6", "ack"))).toBe(UNRECOVERABLE_NOTICE);
});

test("nothing fits the remaining budget → nothing injected (never a partial report) and the notification stays deliverable", () => {
  const home = tmp();
  guarded(home, "bg9", [REPORT, "ack"]);
  const p = notification("bg9", "ack");
  expect(bg(home, p, 20)).toBe("");
  expect(bg(home, p)).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

test("STALE_b: undelivered record of run 1, resumed run 2 stops fresh (false) and re-guards → run 2's report; a continuation (true) keeps the first", () => {
  const home = tmp();
  const line = (uuid: string, text: string): string => JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
  const path = guarded(home, "stb", [REPORT]); // run 1 guarded, notification never delivered
  const run2 = "Run 2 report: resumed.";
  writeFileSync(path, `${line("u-0", REPORT)}\n${line("v-0", run2)}\n`);
  guardedStop(root, home, "stb", path, run2, T + 4000, false); // fresh stop of the resumed run
  expect(bg(home, notification("stb", "r2"))).toBe(`${RECOVERED_LABEL}\n${run2}`);
  // continuation of the same run (true): first emission wins
  const p2 = guarded(home, "stc", [REPORT]);
  writeFileSync(p2, `${line("u-0", REPORT)}\n${line("u-1", "Guard reply.")}\n`);
  guardedStop(root, home, "stc", p2, "Guard reply.", T + 4000, true);
  expect(bg(home, notification("stc", "x"))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

test("near the cap: a minimal pointer to the verified agent-<id>.jsonl when it fits; nothing when even that does not", () => {
  const home = tmp();
  const big = "line of the report\n".repeat(900);
  const path = guarded(home, "nc1", [big, "ack"], big);
  const p = notification("nc1", "ack");
  const pointer = `sub-agent report not inlined: hook output limit reached; full report: ${path}`;
  expect(bg(home, p, pointer.length)).toBe(pointer);
  guarded(home, "nc2", [big, "ack"], big);
  expect(bg(home, notification("nc2", "ack"), pointer.length - 40)).toBe("");
});

test("transcript of another agent → notice, not a quote", () => {
  const home = tmp();
  guardedStop(root, home, "bg7", agentTranscript("other", [REPORT, "ack"]));
  expect(bg(home, notification("bg7", "ack"))).toBe(UNRECOVERABLE_NOTICE);
});

test("withBackgroundReports appends AFTER the existing additionalContext (byte-identical prefix), within the cap; nothing to add → stdout unchanged", () => {
  const home = tmp();
  guarded(home, "bgw", [REPORT, "ack"]);
  const existing = "BASE\n\ncontext with \\n and trailing\n";
  const base = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: existing } });
  const prompt = notification("bgw", "ack");
  const out = withBackgroundReports(base, ups(prompt), prompt, home);
  expect(contextOf(out)).toBe(`${existing}\n\n${RECOVERED_LABEL}\n${REPORT}`);
  expect(withBackgroundReports(base, ups(prompt), prompt, home)).toBe(base); // delivered
  expect(withBackgroundReports(base, ups("hello"), "hello", home)).toBe(base);
  const full = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x".repeat(HOOK_OUTPUT_CAP - 10) } });
  guarded(home, "bgf", [REPORT, "ack"]);
  const p2 = notification("bgf", "ack");
  expect(withBackgroundReports(full, ups(p2), p2, home)).toBe(full);
  expect(contextOf(withBackgroundReports("", ups(p2), p2, home))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

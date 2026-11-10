import { test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { UNRECOVERABLE_NOTICE, RECOVERED_LABEL, recoveredReportContext } from "../src/runtime/lifecycle/report-recovery";
import { REPORT, T, agentResult, agentTranscript, cleanTestDirs, contextOf, guardedStop, tmp } from "./guard-fixtures";

const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
let root = "";
beforeEach(() => { root = tmp(); process.env.CLAUDE_PROJECT_DIR = root; });
afterEach(() => { if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProjectDir; cleanTestDirs(); });

/** Append an assistant text entry to a transcript (the agent speaking after a guard). */
const say = (path: string, text: string, uuid: string): void =>
  appendFileSync(path, JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } }) + "\n");

/** The agent answers the guard, edits its file again and stops again: the guard re-fires (`stop_hook_active`). */
const refire = (home: string, id: string, path: string, reply: string, n: number): void => {
  say(path, reply, `reply-${id}-${n}`);
  guardedStop(root, home, id, path, reply, T + n * 1000, true);
};

test("guard re-fires for the same agent → the parent gets the ORIGINAL pre-guard report, not the hook reply", () => {
  const home = tmp();
  const path = agentTranscript("rf1", ["working…", REPORT]);
  guardedStop(root, home, "rf1", path); // first emission: last message = the real report
  refire(home, "rf1", path, "Guard reply 1: I fixed a lint issue in src/rf1.ts.", 1);
  say(path, "Guard reply 2: sniper green.", "final");
  expect(contextOf(recoveredReportContext(agentResult("rf1", "Guard reply 2: sniper green."), home))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  expect(recoveredReportContext(agentResult("rf1", "x"), home)).toBe(""); // consumed once
});

test("three emissions for the same agent → still the original report, byte-identical", () => {
  const home = tmp();
  const path = agentTranscript("rf3", [REPORT]);
  guardedStop(root, home, "rf3", path);
  refire(home, "rf3", path, "Guard reply 1: fixed.", 1);
  refire(home, "rf3", path, "Guard reply 2: fixed again.", 2);
  say(path, "Guard reply 3: green.", "final");
  expect(contextOf(recoveredReportContext(agentResult("rf3", "Guard reply 3: green."), home))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
});

test("two agents of one session, each re-guarded → each parent gets its own report", () => {
  const home = tmp();
  const reportB = "Agent B report: migrated 2 modules.";
  const pa = agentTranscript("rfa", [REPORT]);
  const pb = agentTranscript("rfb", [reportB]);
  guardedStop(root, home, "rfa", pa);
  guardedStop(root, home, "rfb", pb, reportB);
  refire(home, "rfb", pb, "B guard reply.", 1);
  refire(home, "rfa", pa, "A guard reply.", 2);
  say(pa, "A done.", "fa");
  say(pb, "B done.", "fb");
  expect(contextOf(recoveredReportContext(agentResult("rfa", "A done."), home))).toBe(`${RECOVERED_LABEL}\n${REPORT}`);
  expect(contextOf(recoveredReportContext(agentResult("rfb", "B done."), home))).toBe(`${RECOVERED_LABEL}\n${reportB}`);
});

test("pre-guard report unidentifiable at the first emission → notice, never the later hook reply", () => {
  const home = tmp();
  const path = agentTranscript("rfu", ["only text"]);
  writeFileSync(path, "not json at all\n"); // transcript unreadable at the first emission
  guardedStop(root, home, "rfu", path, "   "); // blank last message: no fingerprint, no uuid
  writeFileSync(path, ""); // later healed: only hook replies in it now
  refire(home, "rfu", path, "Guard reply 1: fixed.", 1);
  say(path, "Guard reply 2: green.", "final");
  const ctx = contextOf(recoveredReportContext(agentResult("rfu", "Guard reply 2: green."), home));
  expect(ctx).toBe(UNRECOVERABLE_NOTICE);
  expect(ctx).not.toContain("Guard reply");
});

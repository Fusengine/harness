import { test, expect, beforeEach, afterEach } from "bun:test";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackAgentMemory } from "../src/runtime/lifecycle/agent-memory";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { validateTaskSolid } from "../src/runtime/lifecycle/task-completed";
import { loadSessionState } from "../src/runtime/home-state";
import { resolveMaxLines } from "../src/config/limits";
import type { SessionChanges } from "../src/runtime/lifecycle/code-edit-time";
import { cleanTestDirs, file, nonTmp, scratchpad, tmp, transcript } from "./guard-fixtures";

const T = 1_000_000_000_000;

const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
beforeEach(() => { delete process.env.CLAUDE_PROJECT_DIR; });
afterEach(() => {
  if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
  cleanTestDirs();
});

const stop = (home: string, root: string, over: Record<string, unknown>, now: number = T): string =>
  trackAgentMemory({ session_id: "s", agent_type: "general-purpose", cwd: root, ...over }, home, now);

// --- SubagentStop: false triggers (R1 / R4) and what stays guarded (R3, R4b) ----------------------

test("SubagentStop: scratchpad probe written by the agent → no sniper demand (R1)", () => {
  const home = tmp(), root = tmp();
  const x = file(join(scratchpad(), "x.py"), "x = 1\n");
  trackSessionChanges("s", x, home, T, { agentId: "A", cwd: root });
  expect(stop(home, root, { agent_id: "A", agent_transcript_path: transcript([x]) })).toContain("no code changes");
  trackSessionChanges("s2", x, home, T, { agentId: "B", cwd: root }); // no transcript: session-wide fallback, still silent
  expect(trackAgentMemory({ session_id: "s2", agent_type: "general-purpose", cwd: root }, home, T)).toContain("no code changes");
});

test("SubagentStop: a temp-area file while the project is elsewhere → silent (R4); out-of-root non-temp = main (R4b)", () => {
  const home = tmp(), root = nonTmp();
  const inTmp = file(join(tmp(), "z.ts"));
  trackSessionChanges("s", inTmp, home, T, { agentId: "A", cwd: root });
  expect(stop(home, root, { agent_id: "A", agent_transcript_path: transcript([inTmp]) })).toContain("no code changes");
  const stray = file(join(nonTmp(), "z.ts")); // outside the root, not temp, no git: demanded exactly like main
  trackSessionChanges("s2", stray, home, T, { agentId: "B", cwd: root });
  const out = trackAgentMemory({ session_id: "s2", agent_type: "general-purpose", cwd: root, agent_id: "B", agent_transcript_path: transcript([stray]) }, home, T);
  expect(out).toContain(`modified 1 code file(s): ${stray}.`);
});

test("SubagentStop control: real project code is still demanded, message unchanged, with and without transcript", () => {
  const home = tmp(), root = tmp();
  const a = file(join(root, "src/a.ts"));
  trackSessionChanges("s", a, home, T, { agentId: "C", cwd: root });
  const expected = `SNIPER VALIDATION REQUIRED: Agent 'general-purpose' modified 1 code file(s): ${a}. Run sniper agent now.`;
  expect(stop(home, root, { agent_id: "C", agent_transcript_path: transcript([a]) })).toContain(expected);
  const home2 = tmp();
  trackSessionChanges("s", a, home2, T, { cwd: root }); // no agent tag, no transcript → session-wide fallback
  expect(stop(home2, root, {})).toContain(expected);
});

// --- SubagentStop: attribution -----------------------------------------------------------------

test("SubagentStop: each agent is judged on its OWN files; the shared counter no longer masks the second one (R3b)", () => {
  const home = tmp(), root = tmp();
  const a = file(join(root, "src/a.ts")), b = file(join(root, "src/b.ts"));
  trackSessionChanges("s", a, home, T, { agentId: "C", cwd: root });
  trackSessionChanges("s", b, home, T, { agentId: "D", cwd: root });
  const c = stop(home, root, { agent_id: "C" }); // no transcripts: only the agent_id-tagged lists attribute
  expect(c).toContain(`modified 1 code file(s): ${a}.`);
  expect(c).not.toContain("b.ts");
  expect(stop(home, root, { agent_id: "D" })).toContain(`modified 1 code file(s): ${b}.`);
  expect(stop(home, root, { agent_id: "C" })).toContain("no code changes"); // not nagged twice for the same file
});

test("SubagentStop: transcript Writes ∪ tagged files; an agent that wrote nothing is not told about a teammate's file", () => {
  const home = tmp(), root = tmp();
  const a = file(join(root, "src/a.ts"));
  trackSessionChanges("s", a, home, T, { agentId: "C", cwd: root });
  expect(stop(home, root, { agent_id: "R", agent_transcript_path: transcript([]) })).toContain("no code changes");
  expect(stop(home, root, { agent_id: "C" })).toContain(`modified 1 code file(s): ${a}.`);
});

test("SubagentStop: a second author of an already-demanded file is held too (with and without agent_id)", () => {
  const home = tmp(), root = tmp(), sibling = tmp();
  const w = file(join(sibling, "src/handle.ts"));
  trackSessionChanges("s", w, home, T, { agentId: "X", cwd: root });
  expect(stop(home, root, { agent_id: "X" })).toContain(`modified 1 code file(s): ${w}.`);
  trackSessionChanges("s", join(root, "lead.ts"), home, T, { cwd: root }); // the lead edits meanwhile (counter back to 1)
  trackSessionChanges("s", w, home, T, { agentId: "Y", cwd: root }); // Y edits the SAME file
  expect(stop(home, root, { agent_id: "Y" })).toContain(`modified 1 code file(s): ${w}.`);
  const home2 = tmp(); // no agent_id: keyed on each agent's own transcript path
  const v = file(join(root, "src/v.ts"));
  trackSessionChanges("s", v, home2, T, { cwd: root });
  expect(stop(home2, root, { agent_transcript_path: transcript([v]) })).toContain(`modified 1 code file(s): ${v}.`);
  trackSessionChanges("s", join(root, "lead.ts"), home2, T, { cwd: root });
  expect(stop(home2, root, { agent_transcript_path: transcript([v]) })).toContain(`modified 1 code file(s): ${v}.`);
});

test("SubagentStop: a file re-edited AFTER its demand is demanded again (fix G); an untouched one is not", () => {
  const home = tmp(), root = tmp();
  const a = file(join(root, "src/a.ts"));
  trackSessionChanges("s", a, home, T, { agentId: "G", cwd: root });
  const at = (now: number): string => stop(home, root, { agent_id: "G" }, now);
  expect(at(T + 10)).toContain(`modified 1 code file(s): ${a}.`);
  expect(at(T + 20)).toContain("no code changes");
  trackSessionChanges("s", a, home, T + 30, { agentId: "G", cwd: root }); // the resumed agent edits it again
  expect(at(T + 40)).toContain(`modified 1 code file(s): ${a}.`);
  expect(at(T + 50)).toContain("no code changes");
});

/** Sub-agent SubagentStop + lead Stop/TaskCompleted replay for a project file at `path` under `root`. */
function replayGuards(root: string, path: string, sid: string): void {
  const home = tmp(), stateDir = tmp();
  trackSessionChanges(sid, path, home, T, { agentId: "Z", cwd: root });
  const sub = trackAgentMemory({ session_id: sid, agent_type: "general-purpose", cwd: root, agent_id: "Z" }, home, T);
  expect(sub).toContain(`modified 1 code file(s): ${path}.`); // sub-agent
  for (const event of ["Stop", "TaskCompleted"]) {
    expect(JSON.parse(validateTaskSolid({ session_id: sid, cwd: root }, home, T, stateDir, event))).toMatchObject({ continue: false }); // lead
  }
}

test("case 15: TMPDIR=<proj>/tmp and the agent writes <proj>/tmp/x.ts → still guarded (sub-agent, lead, Stop)", () => {
  const root = nonTmp(), prev = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "tmp");
  try { replayGuards(root, file(join(root, "tmp", "x.ts")), "c15"); } finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; }
});

test("case 19: a project root that itself sits under a scratchpad-shaped path is still guarded (sub-agent, lead, Stop)", () => {
  const root = join(scratchpad(), "proj");
  replayGuards(root, file(join(root, "src", "a.ts")), "c19");
});

test("case 27b: root = a parent of the scratchpad (session started in /tmp), agent writes ONLY a scratchpad file → silent (sub-agent, lead, Stop)", () => {
  const home = tmp(), stateDir = tmp(), root = tmpdir();
  const x = file(join(scratchpad(), "probe.ts"));
  trackSessionChanges("c27", x, home, T, { agentId: "Z", cwd: root });
  expect(trackAgentMemory({ session_id: "c27", agent_type: "general-purpose", cwd: root, agent_id: "Z" }, home, T)).toContain("no code changes");
  for (const event of ["Stop", "TaskCompleted"]) expect(validateTaskSolid({ session_id: "c27", cwd: root }, home, T, stateDir, event)).toBe("");
});

// --- PostToolUse tracking ----------------------------------------------------------------------

test("trackSessionChanges: tags files with agent_id, ignores unsafe ids, stamps editedAt for project code only", () => {
  const home = tmp(), root = nonTmp();
  const a = join(root, "src/a.ts"), x = join(scratchpad(), "x.py"), z = join(tmp(), "z.ts");
  trackSessionChanges("s", a, home, T, { agentId: "C", cwd: root });
  trackSessionChanges("s", x, home, T + 1, { agentId: "C", cwd: root });
  trackSessionChanges("s", z, home, T + 2, { agentId: "__proto__", cwd: root });
  trackSessionChanges("s", join(root, "src/b.ts"), home, T + 3, { cwd: root }); // lead: untagged
  const changes = loadSessionState("s", home).changes as SessionChanges;
  expect(changes.agentFiles).toEqual({ C: [a, x] });
  expect(Object.keys(changes.editedAt ?? {}).sort()).toEqual([a, join(root, "src/b.ts")].sort());
  expect(changes.modifiedFiles).toContain(z); // still tracked (as before), just never stamped
});

// --- Stop / TaskCompleted: receipt gate + SOLID ---------------------------------------------------

test("Stop / TaskCompleted: scratchpad and temp-area files never trigger the receipt gate or SOLID; project code does", () => {
  const home = tmp(), stateDir = tmp(), root = nonTmp();
  const lines = "// line\n".repeat(resolveMaxLines() + 20);
  const big = file(join(scratchpad(), "huge.ts"), lines), outside = file(join(tmp(), "o.ts"), lines);
  for (const f of [big, outside]) trackSessionChanges("g1", f, home, T);
  for (const event of ["Stop", "TaskCompleted"]) {
    expect(validateTaskSolid({ session_id: "g1", cwd: root }, home, T, stateDir, event)).toBe("");
  }
  for (const f of [big, outside, file(join(root, "src/a.ts"))]) trackSessionChanges("g2", f, home, T);
  const refusal = JSON.parse(validateTaskSolid({ session_id: "g2", cwd: root }, home, T, stateDir, "TaskCompleted")) as { continue: boolean; stopReason: string };
  expect(refusal.continue).toBe(false);
  expect(refusal.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  expect(JSON.parse(validateTaskSolid({ session_id: "g2", cwd: root }, home, T, stateDir, "Stop"))).toMatchObject({ continue: false });
});

test("Stop / TaskCompleted: a symlink inside the project pointing at a temp dir still triggers the receipt gate (challenger A)", () => {
  const home = tmp(), stateDir = tmp(), root = nonTmp(), ext = tmp();
  file(join(ext, "x.ts"));
  symlinkSync(ext, join(root, "vendor"));
  trackSessionChanges("g3", join(root, "vendor", "x.ts"), home, T);
  expect(JSON.parse(validateTaskSolid({ session_id: "g3", cwd: root }, home, T, stateDir, "TaskCompleted"))).toMatchObject({ continue: false });
});

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveSessionState } from "../src/runtime/home-state";
import { validateTaskSolid } from "../src/runtime/lifecycle/task-completed";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { trackFile } from "../src/runtime/paths";
import { saveTrack } from "../src/tracking/store";
import { recordReceipt } from "../src/tracking/receipts";
import { emptyTrack } from "../src/tracking/session-state";

const root = (): string => mkdtempSync(join(tmpdir(), "fh-own-"));
const T = 1_000_000_000_000;

/** A small compliant code file on disk. */
function codeFile(name: string): string {
  const p = join(root(), name);
  writeFileSync(p, "export const x = 1;\n");
  return p;
}

/** Stop-event run (fresh stateDir = no receipt, cadence armed). */
function stop(sid: string, home: string, extra: Record<string, unknown> = {}, stateDir: string = root()): { continue?: boolean; stopReason?: string; systemMessage?: string } | null {
  const out = validateTaskSolid({ session_id: sid, ...extra }, home, T, stateDir, "Stop");
  return out ? (JSON.parse(out) as { continue?: boolean; stopReason?: string; systemMessage?: string }) : null;
}

/** The documented Stop `background_tasks` entry of a sub-agent (its `id` is its `agent_id`). */
const bg = (status: string, id = "agent-1"): { background_tasks: unknown[] } => ({ background_tasks: [{ id, type: "subagent", status, description: "d", agent_type: "general-purpose" }] });

test("own-writes 1: lead Stop while its sub-agent is STILL RUNNING and wrote code -> NOT blocked (the fixed false positive)", () => {
  const home = root();
  trackSessionChanges("o1", codeFile("a.ts"), home, T, { agentId: "agent-1" });
  const r = stop("o1", home, bg("running"));
  expect(r?.continue).toBeUndefined(); // never a refusal while the agent runs
  expect(r?.stopReason).toBeUndefined();
  expect(r?.systemMessage).toContain("UNVERIFIED sub-agent code"); // but visible (non-blocking note)
});

test("own-writes 1b: the sub-agent FINISHED (no longer running) without a receipt -> the lead's Stop blocks (safety net)", () => {
  const home = root();
  trackSessionChanges("o1b", codeFile("a.ts"), home, T, { agentId: "agent-1" });
  expect(stop("o1b", home, { background_tasks: [] })?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  // fail-safe: any status other than "running", an unknown id, or no field at all still blocks
  expect(stop("o1b", home, bg("completed"))?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  expect(stop("o1b", home, bg("running", "other-agent"))?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  expect(stop("o1b", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 1c: the sub-agent FINISHED and a fresh passing receipt exists -> the lead is NOT blocked", async () => {
  const home = root();
  const stateDir = root();
  trackSessionChanges("o1c", codeFile("a.ts"), home, T - 5000, { agentId: "agent-1" });
  await saveTrack(trackFile("o1c", stateDir), recordReceipt(emptyTrack(), { kind: "test", exitCode: 0, pass: 3, fail: 0, ts: T - 1000 }));
  expect(stop("o1c", home, { background_tasks: [] }, stateDir)).toBeNull();
});

test("own-writes 1d: a running agent does not shield a file the lead also wrote -> blocked", () => {
  const home = root();
  const f = codeFile("a.ts");
  trackSessionChanges("o1d", f, home, T, { agentId: "agent-1" });
  trackSessionChanges("o1d", f, home, T + 1);
  expect(stop("o1d", home, bg("running"))?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 2: lead wrote code itself, no receipt -> STILL blocked (negative control)", () => {
  const home = root();
  trackSessionChanges("o2", codeFile("a.ts"), home, T);
  expect(stop("o2", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 2b: lead and sub-agent both wrote -> blocked for the lead's file", () => {
  const home = root();
  trackSessionChanges("o2b", codeFile("a.ts"), home, T, { agentId: "agent-1" });
  trackSessionChanges("o2b", codeFile("b.ts"), home, T + 1);
  expect(stop("o2b", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 2c: the SAME file written by a sub-agent then by the lead -> blocked", () => {
  const home = root();
  const f = codeFile("a.ts");
  trackSessionChanges("o2c", f, home, T, { agentId: "agent-1" });
  trackSessionChanges("o2c", f, home, T + 1);
  expect(stop("o2c", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 3: sub-agent wrote code, no receipt -> that sub-agent's stop STILL blocked", () => {
  const home = root();
  trackSessionChanges("o3", codeFile("a.ts"), home, T, { agentId: "agent-1" });
  expect(stop("o3", home, { agent_id: "agent-1" })?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  // a sibling that wrote nothing is not held for agent-1's file
  expect(stop("o3", home, { agent_id: "agent-2" })).toBeNull();
});

test("own-writes 4: legacy state (no per-writer attribution) keeps the session-wide gate", () => {
  const home = root();
  saveSessionState("o4", { changes: { modifiedFiles: [codeFile("a.ts")] } }, home);
  expect(stop("o4", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 4b: legacy files already tracked before the first attributed write stay the lead's", () => {
  const home = root();
  saveSessionState("o4b", { changes: { modifiedFiles: [codeFile("old.ts")] } }, home);
  trackSessionChanges("o4b", codeFile("new.ts"), home, T, { agentId: "agent-1" });
  expect(stop("o4b", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("own-writes 6: a gate-exempt agent (sniper) edit stays the lead's to verify -> blocked", () => {
  const home = root();
  trackSessionChanges("o6", codeFile("a.ts"), home, T, { agentId: "agent-9", agentType: "fuse-ai-pilot:sniper" });
  expect(stop("o6", home)?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  expect(stop("o6", home, bg("running", "agent-9"))?.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
  // negative control: a non-exempt agent type keeps the sub-agent attribution while it runs
  trackSessionChanges("o6b", codeFile("a.ts"), home, T, { agentId: "agent-9", agentType: "general-purpose" });
  expect(stop("o6b", home, bg("running", "agent-9"))?.continue).toBeUndefined();
});

test("own-writes 5: TaskCompleted (teammates) keeps the session-wide gate", () => {
  const home = root();
  trackSessionChanges("o5", codeFile("a.ts"), home, T, { agentId: "agent-1" });
  const out = validateTaskSolid({ session_id: "o5", task_id: "t", task_subject: "s" }, home, T, root());
  expect((JSON.parse(out) as { stopReason: string }).stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

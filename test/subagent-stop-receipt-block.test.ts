import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackAgentMemory } from "../src/runtime/lifecycle/agent-memory";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { projectStateDir } from "../src/runtime/project-state-dir";
import { trackFile } from "../src/runtime/paths";
import { saveTrack } from "../src/tracking/store";
import { recordReceipt } from "../src/tracking/receipts";
import { emptyTrack } from "../src/tracking/session-state";

const T = 1_000_000_000_000;
const root = (): string => mkdtempSync(join(tmpdir(), "fh-sas-"));
let proj = "";
const prev = process.env.CLAUDE_PROJECT_DIR;
beforeEach(() => { proj = root(); process.env.CLAUDE_PROJECT_DIR = proj; });
afterEach(() => { if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev; });

/** A small code file the sub-agent "wrote" (tagged under its agent_id). */
function agentWrote(sid: string, home: string, agentId = "agent-1"): string {
  const f = join(root(), "a.ts");
  writeFileSync(f, "export const a = 1;\n");
  trackSessionChanges(sid, f, home, T, { agentId });
  return f;
}

/** SubagentStop payload as the harness receives it (documented fields only). */
const stopPayload = (sid: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ session_id: sid, agent_id: "agent-1", agent_type: "general-purpose", hook_event_name: "SubagentStop", stop_hook_active: false, ...extra });

test("SubagentStop: agent wrote code, no receipt -> decision:block naming its files", () => {
  const home = root();
  const f = agentWrote("b1", home);
  const out = JSON.parse(trackAgentMemory(stopPayload("b1"), home, T)) as { decision?: string; reason?: string };
  expect(out.decision).toBe("block");
  expect(out.reason).toContain(f);
  expect(out.reason).toContain("NO VERIFICATION RECEIPT");
});

test("SubagentStop: stop_hook_active=true never blocks (loop exit)", () => {
  const home = root();
  agentWrote("b2", home);
  const out = JSON.parse(trackAgentMemory(stopPayload("b2", { stop_hook_active: true }), home, T)) as { decision?: string };
  expect(out.decision).toBeUndefined();
});

test("SubagentStop: no loop — the same agent/file is demanded once, the next stop passes", () => {
  const home = root();
  agentWrote("b3", home);
  expect((JSON.parse(trackAgentMemory(stopPayload("b3"), home, T)) as { decision?: string }).decision).toBe("block");
  expect((JSON.parse(trackAgentMemory(stopPayload("b3"), home, T + 1)) as { decision?: string }).decision).toBeUndefined();
});

test("SubagentStop: a fresh passing receipt -> no block (reminder only)", async () => {
  const home = root();
  agentWrote("b4", home);
  await saveTrack(trackFile("b4", projectStateDir(proj)), recordReceipt(emptyTrack(), { kind: "test", exitCode: 0, pass: 3, fail: 0, ts: T - 1000 }));
  const out = JSON.parse(trackAgentMemory(stopPayload("b4"), home, T)) as { decision?: string; hookSpecificOutput?: { additionalContext?: string } };
  expect(out.decision).toBeUndefined();
  expect(out.hookSpecificOutput?.additionalContext).toContain("SNIPER VALIDATION REQUIRED");
});

test("SubagentStop: an agent that wrote nothing is never blocked for a sibling's file", () => {
  const home = root();
  agentWrote("b5", home, "agent-1");
  const out = JSON.parse(trackAgentMemory(stopPayload("b5", { agent_id: "agent-2" }), home, T)) as { decision?: string };
  expect(out.decision).toBeUndefined();
});

test("SubagentStop: Codex keeps its advisory systemMessage (no block)", () => {
  const home = root();
  agentWrote("b6", home);
  const out = JSON.parse(trackAgentMemory(stopPayload("b6"), home, T, "codex")) as { decision?: string; systemMessage?: string };
  expect(out.decision).toBeUndefined();
  expect(out.systemMessage).toContain("SNIPER VALIDATION REQUIRED");
});

/**
 * Resume scenario (real-run report bugs 2/3): a task PRD with 4 same-type slots,
 * slots 1-2 already complete on disk, then a FRESH lead session (empty track, new
 * session_id and agent_ids) relaunches two agents that must claim `-3` and `-4`
 * through the real hook path. Never the real `~/.fuse-harness` (HOME = tmp root).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleHook } from "../../src/runtime/handle";
import { prdAgentReportPath } from "../../src/policy/prd";
import { runPrdStatus } from "../../src/cli/prd/status";
import { runPrdValidate } from "../../src/cli/prd/validate";
import { setupPrdEnv, type PrdTestEnv } from "../runtime/prd/env";
import { denyReason, isDenied } from "../runtime/prd/prd-pre-gate-helpers";
import { reportText, seedSlots, slotName, subName } from "../runtime/prd/prd-claim-helpers";
import { capture } from "./prd-fixtures";

const NOW = 1_700_000_000_000;
const TYPE = "fuse-typescript:typescript-expert";

/** One real PreToolUse Write through `handleHook`; the file is written only when the hook did not deny (as the tool would). */
async function hookWrite(env: PrdTestEnv, session: string, agentId: string, slot: number, content: string): Promise<{ denied: boolean; reason: string }> {
  const file = prdAgentReportPath(env.root, env.homeSeg, slotName(TYPE, slot));
  const out = await handleHook("claude-code", {
    hook_event_name: "PreToolUse", tool_name: "Write", session_id: session, agent_id: agentId, agent_type: TYPE,
    tool_input: { file_path: file, content },
  }, { now: NOW, cwd: env.root });
  const denied = isDenied(out.stdout);
  if (!denied) writeFileSync(file, content);
  return { denied, reason: denied ? denyReason(out.stdout) : "" };
}

async function withResume(body: (env: PrdTestEnv) => Promise<void>): Promise<void> {
  const env = setupPrdEnv();
  try {
    process.env.FUSE_PRD = "1";
    seedSlots(env.root, env.homeSeg, TYPE, 4, { done: [1, 2] }); // slots 1,2 complete on disk from the previous lead session
    await body(env);
  } finally {
    delete process.env.FUSE_PRD;
    env.restore();
  }
}

describe("resume-e2e: fresh session claims the remaining -3/-4 slots", () => {
  test("two new agent_ids write -3 and -4 (any order) -> validate exit 0, status 4/4", async () => {
    await withResume(async (env) => {
      const four = await hookWrite(env, "lead-session-2", "new-agent-B", 4, reportText("auth-refactor", [subName(4)]));
      const three = await hookWrite(env, "lead-session-2", "new-agent-A", 3, reportText("auth-refactor", [subName(3)]));
      expect({ four: four.denied, three: three.denied }).toEqual({ four: false, three: false });

      const validate = await capture(() => runPrdValidate(["auth-refactor", "--root", env.root], env.root, { FUSE_PRD: "1" }));
      expect(validate.code).toBe(0);
      const status = await capture(() => runPrdStatus(["--root", env.root], env.root, {}));
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("4/4");
    });
  });

  test("a relaunched agent cannot rewrite the already-complete slots 1/2 nor a slot already claimed this session", async () => {
    await withResume(async (env) => {
      const before = readFileSync(prdAgentReportPath(env.root, env.homeSeg, slotName(TYPE, 1)), "utf8");
      expect((await hookWrite(env, "lead-session-2", "new-agent-A", 1, "{}")).reason).toContain("already reported complete");
      expect(readFileSync(prdAgentReportPath(env.root, env.homeSeg, slotName(TYPE, 1)), "utf8")).toBe(before);
      expect((await hookWrite(env, "lead-session-2", "new-agent-A", 3, reportText("auth-refactor", [subName(3)]))).denied).toBe(false);
      expect((await hookWrite(env, "lead-session-2", "new-agent-B", 3, reportText("auth-refactor", [subName(3)]))).reason).toContain("already owned by another agent");
    });
  });

  test("swapped-slot-fails-validate-not-fabricated: a report landing in the wrong slot is refused at the gate AND would fail validate", async () => {
    await withResume(async (env) => {
      // The gate refuses the swapped content (-3's sub-task written into -4)...
      const swapped = await hookWrite(env, "lead-session-2", "new-agent-A", 4, reportText("auth-refactor", [subName(3)]));
      expect(swapped.denied).toBe(true);
      expect(swapped.reason).toContain("none of which is a sub-task assigned to slot");
      // ...and even if it lands on disk anyway (e.g. an unhooked harness), validate stays red — nothing is fabricated.
      writeFileSync(prdAgentReportPath(env.root, env.homeSeg, slotName(TYPE, 4)), reportText("auth-refactor", [subName(3)]));
      writeFileSync(prdAgentReportPath(env.root, env.homeSeg, slotName(TYPE, 3)), reportText("auth-refactor", [subName(4)]));
      const validate = await capture(() => runPrdValidate(["auth-refactor", "--root", env.root], env.root, { FUSE_PRD: "1" }));
      expect(validate.code).toBe(1);
    });
  });
});

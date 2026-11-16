import { describe, expect, test } from "bun:test";
import { prdPreGate } from "../../../src/runtime/prd/prd-pre-gate";
import { normalizeEvent } from "../../../src/runtime/normalize";
import { loadTrack } from "../../../src/tracking/store";
import { prdAgentReportPath } from "../../../src/policy/prd";
import { setupPrdEnv, type PrdTestEnv } from "./env";
import { denyReason, isDenied } from "./prd-pre-gate-helpers";
import { reportText, seedSlots, slotName, subName, writeWith } from "./prd-claim-helpers";

const NOW = 1_700_000_000_000;
const T = "worker";

async function withEnv(body: (env: PrdTestEnv, slot2: string) => Promise<void>): Promise<void> {
  const env = setupPrdEnv();
  try {
    process.env.FUSE_PRD = "1";
    seedSlots(env.root, env.homeSeg, T, 3, {});
    await body(env, prdAgentReportPath(env.root, env.homeSeg, slotName(T, 2)));
  } finally {
    delete process.env.FUSE_PRD;
    env.restore();
  }
}

const gate = (env: PrdTestEnv, event: ReturnType<typeof writeWith>) => prdPreGate("claude-code", {}, event, env.root, env.trackFilePath, NOW);

describe("first-claim content must name one of the slot's own sub-tasks (derivable content only)", () => {
  test("claim-content-overlap-denies-foreign-subs: a report naming only another slot's sub-tasks is refused and binds nothing", async () => {
    await withEnv(async (env, slot2) => {
      const out = await gate(env, writeWith(env.sessionId, slot2, reportText("auth-refactor", [subName(1)]), "a1", T));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("none of which is a sub-task assigned to slot");
      expect((await loadTrack(env.trackFilePath)).prdOwners ?? {}).toEqual({});
    });
  });

  test("right sub-task name under an unknown task is also foreign", async () => {
    await withEnv(async (env, slot2) => {
      const out = await gate(env, writeWith(env.sessionId, slot2, reportText("some-other-task", [subName(2)]), "a1", T));
      expect(isDenied(out!.stdout)).toBe(true);
    });
  });

  test("any overlap is enough (own + foreign sub-tasks mixed): allowed, binds", async () => {
    await withEnv(async (env, slot2) => {
      const out = await gate(env, writeWith(env.sessionId, slot2, reportText("auth-refactor", [subName(1), subName(2)]), "a1", T));
      expect(isDenied(out!.stdout)).toBe(false);
      expect((await loadTrack(env.trackFilePath)).prdOwners).toEqual({ a1: slotName(T, 2) });
    });
  });

});

describe("claim-underivable-content-not-judged (one fresh env per case)", () => {
  const cases: [string, (env: PrdTestEnv, slot2: string) => ReturnType<typeof normalizeEvent>][] = [
    ["empty object", (e, f) => writeWith(e.sessionId, f, "{}", "a1", T)],
    ["non-JSON text", (e, f) => writeWith(e.sessionId, f, "not json", "a1", T)],
    ["JSON array", (e, f) => writeWith(e.sessionId, f, "[1,2]", "a1", T)],
    ["scalar task value", (e, f) => writeWith(e.sessionId, f, JSON.stringify({ t: "scalar" }), "a1", T)],
    ["Edit on a missing file (current text unknown)", (e, f) => normalizeEvent("claude-code", {
      hook_event_name: "PreToolUse", tool_name: "Edit", session_id: e.sessionId, agent_id: "a1", agent_type: T,
      tool_input: { file_path: f, old_string: "x", new_string: JSON.stringify({ "auth-refactor": { [subName(1)]: {} } }) },
    })],
  ];
  for (const [label, build] of cases) {
    test(`not judged: ${label}`, async () => {
      await withEnv(async (env, slot2) => {
        expect(isDenied((await gate(env, build(env, slot2)))!.stdout)).toBe(false);
      });
    });
  }

  test("only the FIRST claim is judged: the owner may later write any content to its own slot", async () => {
    await withEnv(async (env, slot2) => {
      expect(isDenied((await gate(env, writeWith(env.sessionId, slot2, reportText("auth-refactor", [subName(2)]), "a1", T)))!.stdout)).toBe(false);
      expect(isDenied((await gate(env, writeWith(env.sessionId, slot2, reportText("auth-refactor", [subName(1)]), "a1", T)))!.stdout)).toBe(false);
    });
  });
});

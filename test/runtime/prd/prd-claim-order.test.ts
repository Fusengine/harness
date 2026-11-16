import { describe, expect, test } from "bun:test";
import { prdPreGate } from "../../../src/runtime/prd/prd-pre-gate";
import { normalizeEvent } from "../../../src/runtime/normalize";
import { loadTrack } from "../../../src/tracking/store";
import { defaultStateDir, trackFile } from "../../../src/runtime/paths";
import { prdAgentReportPath } from "../../../src/policy/prd";
import { setupPrdEnv, type PrdTestEnv } from "./env";
import { denyReason, isDenied } from "./prd-pre-gate-helpers";
import { reportText, seedSlots, slotName, subName, writeWith } from "./prd-claim-helpers";

const NOW = 1_700_000_000_000;
const T = "worker";

/** Runs `body` against a FUSE_PRD-enabled env seeded with `n` slots of `T`. */
async function withSlots(n: number, opts: Parameters<typeof seedSlots>[4], body: (env: PrdTestEnv) => Promise<void>, homeSeg = ".claude"): Promise<void> {
  const env = setupPrdEnv(homeSeg);
  try {
    process.env.FUSE_PRD = "1";
    seedSlots(env.root, env.homeSeg, T, n, opts);
    await body(env);
  } finally {
    delete process.env.FUSE_PRD;
    env.restore();
  }
}

/** One own-slot write by `agentId` on `slot` (content names that slot's own sub-task), against `track`. */
async function claim(env: PrdTestEnv, slot: number, agentId: string, agentType = T, track = env.trackFilePath, session = env.sessionId) {
  const file = prdAgentReportPath(env.root, env.homeSeg, slotName(agentType, slot));
  const out = await prdPreGate("claude-code", {}, writeWith(session, file, reportText("auth-refactor", [subName(slot)]), agentId, agentType), env.root, track, NOW);
  expect(out).not.toBeNull();
  return out!;
}

describe("claim order independence (real gate)", () => {
  test("claim-nth-before-exact: -3 first, then the exact slot by another agent", async () => {
    await withSlots(3, {}, async (env) => {
      expect(isDenied((await claim(env, 3, "a1")).stdout)).toBe(false);
      expect(isDenied((await claim(env, 1, "a2")).stdout)).toBe(false);
      expect((await loadTrack(env.trackFilePath)).prdOwners).toEqual({ a1: slotName(T, 3), a2: slotName(T, 1) });
    });
  });

  test("claim-any-order-4-agents-5th-denied", async () => {
    await withSlots(4, {}, async (env) => {
      for (const [id, slot] of [["a1", 4], ["a2", 1], ["a3", 3], ["a4", 2]] as const) expect(isDenied((await claim(env, slot, id)).stdout)).toBe(false);
      for (const slot of [1, 2, 3, 4]) expect(isDenied((await claim(env, slot, "a5")).stdout)).toBe(true);
      const sixth = await claim(env, 5, "a5");
      expect(denyReason(sixth.stdout)).toContain("not a slot of your agent_type");
    });
  });

  test("claim-one-slot-per-agent + claim-live-bound-slot-denied-to-other-id: distinct messages", async () => {
    await withSlots(3, {}, async (env) => {
      await claim(env, 2, "a1");
      expect(denyReason((await claim(env, 3, "a1")).stdout)).toContain("one slot per agent");
      expect(denyReason((await claim(env, 2, "a2")).stdout)).toContain("already owned by another agent");
      expect(isDenied((await claim(env, 2, "a1")).stdout)).toBe(false); // owner rewrites its own slot
    });
  });

  test("claim-closed-slot-denied-fresh-session: complete on disk, empty track, new agent_id -> denied; open slot next to it is claimable", async () => {
    await withSlots(3, { done: [1, 2] }, async (env) => {
      const freshTrack = trackFile("s-fresh", defaultStateDir(env.root));
      const closed = await claim(env, 2, "n1", T, freshTrack, "s-fresh");
      expect(denyReason(closed.stdout)).toContain("already reported complete");
      expect(isDenied((await claim(env, 3, "n1", T, freshTrack, "s-fresh")).stdout)).toBe(false);
    });
  });

  test("claim-closed-slot-owner-may-rewrite: the session owner keeps writing its (now complete) slot", async () => {
    await withSlots(2, {}, async (env) => {
      expect(isDenied((await claim(env, 2, "a1")).stdout)).toBe(false);
      seedSlots(env.root, env.homeSeg, T, 2, { done: [2] }); // its report is now complete on disk
      expect(isDenied((await claim(env, 2, "a1")).stdout)).toBe(false);
      expect(isDenied((await claim(env, 2, "a2")).stdout)).toBe(true);
    });
  });

  test("claim-partial-report-of-dead-agent-claimable", async () => {
    await withSlots(2, { partial: [2] }, async (env) => {
      expect(isDenied((await claim(env, 2, "n1")).stdout)).toBe(false);
    });
  });

  test("claim-compacted-slot-never-claimable", async () => {
    await withSlots(2, { compacted: [2] }, async (env) => {
      expect(denyReason((await claim(env, 2, "n1")).stdout)).toContain("already reported complete");
    });
  });

  test("claim-type-mismatch-denied: another type may not take a worker slot", async () => {
    await withSlots(2, {}, async (env) => {
      const out = await claim(env, 2, "n1", "other-expert");
      expect(denyReason(out.stdout)).toContain("not a slot of your agent_type");
    });
  });

  test("claim-agent-id-without-type-denied", async () => {
    await withSlots(2, {}, async (env) => {
      const file = prdAgentReportPath(env.root, env.homeSeg, slotName(T, 2));
      const out = await prdPreGate("claude-code", {}, writeWith(env.sessionId, file, "{}", "n1"), env.root, env.trackFilePath, NOW);
      expect(isDenied(out!.stdout)).toBe(true);
    });
  });

  test("claim-lead-and-unknown-unchanged: lead denied, cursor (lead:unknown) never hard-denied", async () => {
    await withSlots(2, {}, async (env) => {
      const file = prdAgentReportPath(env.root, env.homeSeg, slotName(T, 2));
      expect(denyReason((await prdPreGate("claude-code", {}, writeWith(env.sessionId, file, "{}"), env.root, env.trackFilePath, NOW))!.stdout)).toContain("coordinator");
    });
    await withSlots(2, {}, async (env) => {
      const file = prdAgentReportPath(env.root, env.homeSeg, slotName(T, 2));
      const ev = normalizeEvent("cursor", { hook_event_name: "preToolUse", session_id: env.sessionId, tool_name: "Write", tool_input: { file_path: file, content: "{}" } });
      const out = await prdPreGate("cursor", {}, ev, env.root, env.trackFilePath, NOW);
      expect(out === null || !isDenied(out.stdout)).toBe(true);
    }, ".cursor");
  });

  test("claim-apply-patch-two-slots-one-envelope-denied", async () => {
    await withSlots(2, {}, async (env) => {
      const a = prdAgentReportPath(env.root, env.homeSeg, slotName(T, 1));
      const b = prdAgentReportPath(env.root, env.homeSeg, slotName(T, 2));
      const ev = normalizeEvent("codex", {
        hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: env.sessionId, agent_id: "a1", agent_type: T,
        tool_input: { command: `*** Begin Patch\n*** Add File: ${a}\n+{}\n*** Add File: ${b}\n+{}\n*** End Patch\n` },
      });
      const out = await prdPreGate("codex", {}, ev, env.root, env.trackFilePath, NOW);
      expect(denyReason(out!.stdout)).toContain("one slot per agent");
      expect((await loadTrack(env.trackFilePath)).prdOwners ?? {}).toEqual({}); // nothing bound by a denied envelope
    }, ".codex");
  });

  test("claim-race-check-and-set: N concurrent claims of ONE slot -> exactly one allowed, one binding persisted", async () => {
    await withSlots(2, {}, async (env) => {
      const ids = ["r1", "r2", "r3", "r4", "r5"];
      const outs = await Promise.all(ids.map((id) => claim(env, 2, id)));
      expect(outs.filter((o) => !isDenied(o.stdout))).toHaveLength(1);
      const owners = (await loadTrack(env.trackFilePath)).prdOwners ?? {};
      expect(Object.values(owners)).toEqual([slotName(T, 2)]);
    });
  });

  test("claim-race-check-and-set (two slots, one agent): concurrent claims by ONE agent persist a single slot", async () => {
    await withSlots(3, {}, async (env) => {
      const outs = await Promise.all([claim(env, 1, "r1"), claim(env, 2, "r1"), claim(env, 3, "r1")]);
      expect(outs.filter((o) => !isDenied(o.stdout))).toHaveLength(1);
      expect(Object.keys((await loadTrack(env.trackFilePath)).prdOwners ?? {})).toEqual(["r1"]);
    });
  });
});

describe("plugin-prefixed agent_type (':' in the report filename)", () => {
  const PT = "fuse-typescript:typescript-expert";
  test("claims, closed-slot denial and rewrites work with a ':' type end-to-end", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      seedSlots(env.root, env.homeSeg, PT, 3, { done: [1] });
      expect(prdAgentReportPath(env.root, env.homeSeg, slotName(PT, 2))).toContain("typescript-expert-2-prd.json");
      expect(isDenied((await claim(env, 3, "a1", PT)).stdout)).toBe(false);
      expect(isDenied((await claim(env, 2, "a2", PT)).stdout)).toBe(false);
      expect(denyReason((await claim(env, 1, "a3", PT)).stdout)).toContain("already reported complete");
      expect(isDenied((await claim(env, 3, "a1", PT)).stdout)).toBe(false);
      expect(Object.values((await loadTrack(env.trackFilePath)).prdOwners ?? {}).sort()).toEqual([slotName(PT, 2), slotName(PT, 3)]);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

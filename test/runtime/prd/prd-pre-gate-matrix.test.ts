import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { prdPreGate } from "../../../src/runtime/prd/prd-pre-gate";
import { normalizeEvent } from "../../../src/runtime/normalize";
import { prdAgentReportPath, prdDocsPath, prdRouterPath, prdTaskPath } from "../../../src/policy/prd";
import { loadTrack } from "../../../src/tracking/store";
import { reopenFixtureSlot, setupPrdEnv } from "./env";
import { denyReason, writeEvent } from "./prd-pre-gate-helpers";

const NOW = 1_700_000_000_000;

describe("B1 — coordinator-only paths, apply_patch envelope, Bash, Cursor, edge cases", () => {
  test("lead writes router/task/docs: allowed WITH the flag; the SAME write is denied WITHOUT it (witness)", async () => {
    const env = setupPrdEnv();
    try {
      const targets = [prdRouterPath(env.root, env.homeSeg), prdTaskPath(env.root, env.homeSeg, "prd/auth-refactor-prd.json"), prdDocsPath(env.root, env.homeSeg, "auth-refactor")];
      for (const target of targets) {
        delete process.env.FUSE_PRD;
        expect(await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target), env.root, env.trackFilePath, NOW)).toBeNull();

        process.env.FUSE_PRD = "1";
        const withFlag = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target), env.root, env.trackFilePath, NOW);
        expect(withFlag).not.toBeNull();
        expect(withFlag!.stdout).not.toContain("\"deny\"");
      }
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("lead writing an agent's own report file is denied", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");
      const out = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target), env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(denyReason(out!.stdout)).toContain("coordinator");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("apply_patch envelope with 3 files, one owned by a different agent, denies the WHOLE envelope naming that path", async () => {
    const env = setupPrdEnv(".codex"); // codex's homeSeg — must match harnessHomeSegment("codex")
    try {
      process.env.FUSE_PRD = "1";
      reopenFixtureSlot(env.root, env.homeSeg);
      const own = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const foreign =prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");
      const event = normalizeEvent("codex", {
        hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: env.sessionId, agent_id: "a1", agent_type: "backend-expert",
        tool_input: { command: `*** Begin Patch\n*** Update File: ${own}\n@@\n+x\n*** Update File: ${foreign}\n@@\n+y\n*** Add File: ${join(env.root, "src", "unrelated.ts")}\n+z\n*** End Patch\n` },
      });
      const out = await prdPreGate("codex", {}, event, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(denyReason(out!.stdout)).toContain(foreign);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("Bash write-redirect under prd/ is denied for everyone (even the lead); a plain `cat` is untouched", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const denyEvent = normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: env.sessionId, tool_input: { command: `echo x > ${target}` } });
      const out = await prdPreGate("claude-code", {}, denyEvent, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(out!.stdout).toContain("Bash");

      const catEvent = normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: env.sessionId, tool_input: { command: `cat ${target}` } });
      expect(await prdPreGate("claude-code", {}, catEvent, env.root, env.trackFilePath, NOW)).toBeNull();
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("Cursor sub-agent write, no identity fields on the event: advisory — allowed, never blocked", async () => {
    const env = setupPrdEnv(".cursor"); // cursor's homeSeg — must match harnessHomeSegment("cursor")
    try {
      process.env.FUSE_PRD = "1";
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const event = normalizeEvent("cursor", { hook_event_name: "preToolUse", session_id: env.sessionId, tool_name: "Write", tool_input: { file_path: target, content: "{}" } });
      const out = await prdPreGate("cursor", {}, event, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(out!.stdout).not.toContain("\"deny\"");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("agent_id present without agent_type: denied (fail-closed, distinct from Cursor/Kimi's advisory)", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const event = writeEvent(env.sessionId, target, "a1"); // agent_id, no agent_type
      const out = await prdPreGate("claude-code", {}, event, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(denyReason(out!.stdout)).toContain("unidentifiable agent_type");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("corrupted router denies only in-scope PRD writes; an unrelated file in the same session passes", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      writeFileSync(prdRouterPath(env.root, env.homeSeg), "{ not json");
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const out = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target, "a1", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(denyReason(out!.stdout)).toContain("malformed JSON");

      const elsewhere = join(env.root, "src", "elsewhere.ts");
      const passthrough = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, elsewhere), env.root, env.trackFilePath, NOW);
      expect(passthrough).toBeNull();
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("REGRESSION: apply_patch envelope mixing an allowed PRD write with a genuinely unrelated oversized file never short-circuits past the normal gate chain for that unrelated file", async () => {
    const env = setupPrdEnv(".codex"); // codex's homeSeg — must match harnessHomeSegment("codex")
    try {
      process.env.FUSE_PRD = "1";
      reopenFixtureSlot(env.root, env.homeSeg);
      const own = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      // An oversized unrelated file (well over the SOLID file-size default cap,
      // 100 lines) bundled in the SAME apply_patch envelope as a legitimate PRD
      // write. classifyPrdPath returns null for it (not under apex/prd/ at all)
      // — it must never ride the PRD gate's allow bypass; the normal
      // applyPatchGate/gate() SOLID check must still see it.
      const oversized = join(env.root, "src", "unrelated-oversized.ts");
      const bigLines = Array.from({ length: 400 }, (_, i) => `+const line${i} = ${i};`).join("\n");
      const event = normalizeEvent("codex", {
        hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: env.sessionId, agent_id: "a1", agent_type: "backend-expert",
        tool_input: { command: `*** Begin Patch\n*** Update File: ${own}\n@@\n+x\n*** Add File: ${oversized}\n${bigLines}\n*** End Patch\n` },
      });
      const out = await prdPreGate("codex", {}, event, env.root, env.trackFilePath, NOW);
      // Must fall through (null) rather than short-circuit-allow the whole
      // envelope: the oversized unrelated file was never classified in-scope,
      // so the PRD gate must never be the one to wave it through.
      expect(out).toBeNull();
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("REGRESSION: exact name already bound to a DIFFERENT agentId — a fresh agentId claiming the sole remaining sibling is ALLOWED and journaled; the SAME fresh agentId then trying the taken exact name is DENIED", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      reopenFixtureSlot(env.root, env.homeSeg);
      const exactTarget = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const siblingTarget = prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");

      // a1 claims the exact name first (pre-existing binding this test depends on).
      const first = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, exactTarget, "a1", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(first).not.toBeNull();
      expect(first!.stdout).not.toContain("\"deny\"");

      // a2 (fresh agentId, SAME agentType) claims the sole remaining free
      // sibling -> allowed, and the bind is journaled.
      const second = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, siblingTarget, "a2", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(second).not.toBeNull();
      expect(second!.stdout).not.toContain("\"deny\"");
      const track = await loadTrack(env.trackFilePath);
      expect(track.prdOwners).toEqual({ a1: "backend-expert", a2: "backend-expert-2" });

      // a2 then reaching for the exact name (already bound to a1) is denied.
      const third = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, exactTarget, "a2", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(third).not.toBeNull();
      expect(denyReason(third!.stdout)).toContain(exactTarget);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

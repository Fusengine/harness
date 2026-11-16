import { describe, expect, test } from "bun:test";
import { prdSubagentContext } from "../../../src/runtime/prd/prd-subagent-context";
import { additionalContextOf } from "../../../src/runtime/post-outcome";
import { joinContextResponses } from "../../../src/policy/prd";
import { setupPrdEnv } from "./env";

/** Exact pre-`agentSlices` output for the unambiguous case (captured live, single candidate) — pinned so the switch to `agentSlices` provably never touches this path. */
const unambiguousBytes = (root: string, homeSeg = ".claude"): string => "{\"hookSpecificOutput\":{\"hookEventName\":\"SubagentStart\",\"additionalContext\":\"## PRD assignment — task auth-refactor\\nYour files: src/auth/session.ts\\nYour sub-tasks: session-store\\nReport to " + root + "/" + homeSeg + "/apex/prd/agents/backend-expert-2-prd.json when done (absolute path — never <project>/prd/agents/).\\n\\n### Rules\\n1. Write ONLY the files listed in your slice above.\\n2. Report completion to YOUR OWN agent-report file above — never another agent's.\\n3. Do not mark a sub-task done until the work is actually finished; the coordinator validates from your report.\"}}";

describe("B3 — SubagentStart PRD slice injection", () => {
  test("agent_type=backend-expert-2 (unique candidate): output byte-identical to before the agentSlices switch", () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const out = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, "claude-code");
      expect(out).toBe(unambiguousBytes(env.root));
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("agent_type=backend-expert (ambiguous, 2 same-type siblings): the injected context now carries the disambiguation header AND both agents' full slices — no longer \"\"", () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const out = prdSubagentContext({ agent_type: "backend-expert" }, env.root, "claude-code");
      const text = additionalContextOf(out);
      expect(text).toContain("Several assignments match your agent type");
      expect(text).toContain("You are ONE of: backend-expert, backend-expert-2");
      // BOTH agents' own slices are present, not just one.
      expect(text).toContain("prd/agents/backend-expert-prd.json");
      expect(text).toContain("prd/agents/backend-expert-2-prd.json");
      expect(text).toContain("src/auth/login.ts");
      expect(text).toContain("src/auth/session.ts");
      expect(text).toContain("jwt-validation");
      expect(text).toContain("session-store");
      expect(text.match(/^\d+\.\s/gm)?.length).toBe(3); // still exactly 3 numbered rules (once, not per-agent)
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("an unnamed agent gets \"\"", () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      expect(prdSubagentContext({}, env.root, "claude-code")).toBe("");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("flag absent: \"\" regardless of agent_type", () => {
    const env = setupPrdEnv();
    try {
      delete process.env.FUSE_PRD;
      expect(prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, "claude-code")).toBe("");
    } finally {
      env.restore();
    }
  });
});

describe("B3 defect fix — native context shape for gemini-cli/cline (was: Claude-shaped hookSpecificOutput.additionalContext neither honors identically)", () => {
  test("cline gets its native contextModification shape, not the Claude hookSpecificOutput envelope", () => {
    const env = setupPrdEnv(".clinerules");
    try {
      process.env.FUSE_PRD = "1";
      const out = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, "cline");
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed).toHaveProperty("contextModification");
      expect(parsed).not.toHaveProperty("hookSpecificOutput");
      expect(String(parsed.contextModification)).toContain("session-store");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("gemini-cli gets a hookSpecificOutput.additionalContext with NO hookEventName field (its native shape)", () => {
    const env = setupPrdEnv(".gemini");
    try {
      process.env.FUSE_PRD = "1";
      const out = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, "gemini-cli");
      const parsed = JSON.parse(out) as { hookSpecificOutput?: Record<string, unknown> };
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput).not.toHaveProperty("hookEventName");
      expect(String(parsed.hookSpecificOutput?.additionalContext)).toContain("session-store");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

describe("B3 non-regression — byte-identical output for the 5 protected targets (pinned, captured BEFORE the respond() routing fix)", () => {
  test.each([
    ["claude-code", ".claude"],
    ["codex", ".codex"],
    ["hermes", ".hermes"],
    ["cursor", ".cursor"],
    ["kimi", ".kimi-code"],
  ])("%s output stays byte-identical", (id, homeSeg) => {
    const env = setupPrdEnv(homeSeg);
    try {
      process.env.FUSE_PRD = "1";
      const out = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, id);
      expect(out).toBe(unambiguousBytes(env.root, homeSeg));
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

// RED (measured defect, this exact composition is `dispatch.ts`'s SubagentStart
// branch: `joinContextResponses(subagentCacheContext(...), prdSubagentContext(...))`):
// `prdSubagentContext` builds cline's slice correctly (proven above), but before
// the `joinContextResponses` fix, merging it silently dropped to "" — cline never
// receives its PRD tranche. `cacheContext` is "" here (the common no-MCP-cache-yet
// case measured live: 0 bytes on real SubagentStart for cline).
describe("B3 defect — the merge step must not drop cline's slice (real dispatch.ts composition)", () => {
  test("cline's slice survives joinContextResponses(cacheContext, prdSlice) — was silently dropped to \"\"", () => {
    const env = setupPrdEnv(".clinerules");
    try {
      process.env.FUSE_PRD = "1";
      const prdSlice = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, "cline");
      const merged = joinContextResponses("", prdSlice);
      expect(merged).not.toBe("");
      const parsed = JSON.parse(merged) as { contextModification?: string };
      expect(parsed.contextModification).toContain("session-store");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

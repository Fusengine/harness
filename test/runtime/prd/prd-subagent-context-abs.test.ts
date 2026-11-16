import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { prdSubagentContext } from "../../../src/runtime/prd/prd-subagent-context";
import { additionalContextOf } from "../../../src/runtime/post-outcome";
import { harnessHomeSegment } from "../../../src/policy/apex-target";
import { setupPrdEnv } from "./env";

/** Every host whose SubagentStart slice must carry the ABSOLUTE report path. */
const HOSTS = ["claude-code", "codex", "cursor", "kimi", "gemini-cli", "cline"] as const;

describe("SubagentStart slice — absolute report path per host", () => {
  for (const id of HOSTS) {
    test(`${id}: slice names <root>/<homeSeg>/apex/prd/agents/<agent>-prd.json`, () => {
      const homeSeg = harnessHomeSegment(id);
      const env = setupPrdEnv(homeSeg);
      try {
        process.env.FUSE_PRD = "1";
        const out = prdSubagentContext({ agent_type: "backend-expert-2" }, env.root, id);
        const abs = join(env.root, homeSeg, "apex", "prd", "agents", "backend-expert-2-prd.json");
        const text = id === "gemini-cli" || id === "cline" ? out : additionalContextOf(out);
        expect(text).toContain(`Report to ${abs} when done`);
        expect(text).toContain("never <project>/prd/agents/");
        expect(text).not.toContain("Report to prd/agents/");
      } finally {
        delete process.env.FUSE_PRD;
        env.restore();
      }
    });
  }
});

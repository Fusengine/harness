import { describe, expect, test } from "bun:test";
import { renderAgentSliceMarkdown } from "../../../src/policy/prd";
import type { PrdSubagentSlice } from "../../../src/policy/prd";

const slices: PrdSubagentSlice[] = [
  { task: "t", agent: "a", subTasks: ["s"], files: ["f.ts"] },
  { task: "t", agent: "b", subTasks: ["s2"], files: ["g.ts"] },
];

describe("renderAgentSliceMarkdown with an absolute-path context", () => {
  test("renders the absolute report path per agent", () => {
    const text = renderAgentSliceMarkdown(slices, { root: "/p", homeSeg: ".codex" });
    expect(text).toContain("Report to /p/.codex/apex/prd/agents/a-prd.json when done (absolute path — never <project>/prd/agents/).");
    expect(text).toContain("Report to /p/.codex/apex/prd/agents/b-prd.json when done");
    expect(text).not.toContain("Report to prd/agents/");
  });
  test("no context -> legacy relative rendering, unchanged", () => {
    expect(renderAgentSliceMarkdown(slices)).toContain("Report to prd/agents/a-prd.json when done.");
  });
});

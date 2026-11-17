import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apexAuthorizationGate } from "../src/policy/apex-authorization";
import { enrichRepeatDeny } from "../src/policy/deny-loop";
import { routeReferences, frameworkSkill } from "../src/refs/router";
import { syncTaskTracking } from "../src/runtime/lifecycle/aipilot/sync-task";
import type { RefMeta } from "../src/refs/types";
import { mkSkill, ref, tmp } from "./host-aware-fixtures";

function tsxRef(dir: string, name: string, level: string, keywords: string): RefMeta {
  return { ...ref(join(dir, `${name}.md`), name, level), keywords };
}

test("routing: a tanstack-start edit routes solid-tanstack-start, on claude-code AND codex installs", () => {
  const home = tmp();
  const layouts: [string, string][] = [
    ["claude-code", join(home, ".claude", "plugins", "marketplaces", "m", "plugins")],
    ["codex", join(home, ".codex", "plugins", "cache", "fusengine-codex")],
  ];
  for (const [id, root] of layouts) {
    const sub = id === "codex" ? "1.0.0/skills" : "skills";
    const react = mkSkill(join(root, "react-expert", sub), "solid-react");
    const start = mkSkill(join(root, "tanstack-start-expert", sub), "solid-tanstack-start");
    // react's refs out-score (more keywords): the framework's own skill must still win.
    const refs = [tsxRef(react, "r1", "principle", "route,loader,component"), tsxRef(react, "r2", "template", "route,loader"), tsxRef(start, "t1", "principle", ""), tsxRef(start, "t2", "template", "")];
    const d = apexAuthorizationGate({ hostId: id, sessionId: "s", framework: "tanstack-start", filePath: "/p/src/routes/a.tsx", content: "route loader component", refs });
    expect(d?.reason).toContain(`Full skill: ${start.replace(/\/references$/, "")}/SKILL.md`);
    expect(d?.reason).not.toContain("solid-react");
    expect(d?.actions?.every((a) => a.includes("solid-tanstack-start"))).toBe(true);
  }
});

test("routing: no own ref scored → unchanged flat scoring (generic, react-without-own, laravel alias)", () => {
  const react = [ref("/x/skills/solid-react/references/a.md", "a", "principle")];
  const base = routeReferences(react, "/p/a.tsx", "");
  // A framework whose own skill is absent from the refs: result identical to omitting the framework.
  for (const fw of ["tanstack-start", "nextjs", "generic", "tailwind", ""]) expect(routeReferences(react, "/p/a.tsx", "", "", fw)).toEqual(base);
  expect(frameworkSkill("laravel")).toBe("solid-php");
  expect(frameworkSkill("generic")).toBeUndefined();
  expect(frameworkSkill("tanstack-start")).toBe("solid-tanstack-start");
});

test("deny-loop repeat action: Claude byte-identical, other hosts use the bare agent name", () => {
  const p = { kind: "block" as const, title: "t", reason: "r" };
  expect(enrichRepeatDeny(p, 2).actions?.[0]).toBe("Launch fuse-ai-pilot:research-expert to find a DIFFERENT approach");
  expect(enrichRepeatDeny(p, 2, "claude-code").actions?.[0]).toBe("Launch fuse-ai-pilot:research-expert to find a DIFFERENT approach");
  for (const id of ["codex", "kimi", "cursor"]) expect(enrichRepeatDeny(p, 2, id).actions?.[0]).toBe("Launch research-expert to find a DIFFERENT approach");
});

test("task sync commit reminder: Claude names fuse-ai-pilot:commit, Codex the bare commit agent", async () => {
  for (const [id, seg, want] of [["claude-code", ".claude", "agent fuse-ai-pilot:commit "], ["codex", ".codex", "agent commit "]] as const) {
    const root = tmp();
    mkdirSync(join(root, seg, "apex"), { recursive: true });
    writeFileSync(join(root, seg, "apex", "task.json"), JSON.stringify({ tasks: { "1": { subject: "S", status: "in_progress" } } }));
    // Hardened git on a repo this test creates (no inherited config, no fsmonitor, no hooks).
    execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: root, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10000 });
    writeFileSync(join(root, "dirty.txt"), "x");
    const prevDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      const out = await syncTaskTracking({ tool_name: "TaskUpdate", tool_input: { taskId: "1", status: "completed" } }, root, id);
      const text = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(text).toContain(want);
      if (id === "codex") expect(text).not.toContain("fuse-ai-pilot");
    } finally {
      if (prevDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevDir;
    }
  }
});

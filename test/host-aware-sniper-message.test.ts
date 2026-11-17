import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { discoverRefs } from "../src/refs/discover";
import { apexAuthorizationGate } from "../src/policy/apex-authorization";
import { getSkillSource } from "../src/policy/skill-source";
import { reviewActionLine } from "../src/runtime/release-gate/gate";
import type { ApexContext } from "../src/policy/apex";
import type { RefMeta } from "../src/refs/types";
import { mkSkill, ref, tmp } from "./host-aware-fixtures";

const T = 1_700_000_000_000;

/** The reminder text for `id` (additionalContext of the PostToolUse stdout). */
function reminder(id: string | undefined): string {
  const root = tmp();
  const f = join(root, "button.tsx");
  writeFileSync(f, "export const a = 1;\n");
  const ctx = id === undefined ? { cwd: root } : { cwd: root, id };
  const out = trackSessionChanges(`s-${id}`, f, tmp(), T, ctx);
  return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

const CLAUDE_TEXT = "SNIPER VALIDATION REQUIRED: Code file 'button.tsx' was modified. You MUST now run the sniper agent (fuse-ai-pilot:sniper) to validate this modification before continuing. This is mandatory per CLAUDE.md rules.";

test("sniper reminder: Claude Code (default and explicit) is byte-identical to the historical text", () => {
  expect(reminder(undefined)).toBe(CLAUDE_TEXT);
  expect(reminder("claude-code")).toBe(CLAUDE_TEXT);
});

test("sniper reminder: Codex / Kimi name their own agent and AGENTS.md, never fuse-ai-pilot: nor CLAUDE.md", () => {
  for (const id of ["codex", "kimi"]) {
    const t = reminder(id);
    expect(t).toContain("run the sniper agent (sniper)");
    expect(t).toContain("per AGENTS.md rules");
    expect(t).not.toContain("fuse-ai-pilot");
    expect(t).not.toContain("CLAUDE.md");
  }
});

test("sniper reminder: Cursor and unproven hosts get neutral rules wording and no Claude-only name", () => {
  for (const id of ["cursor", "cline", "gemini-cli", "hermes"]) {
    const t = reminder(id);
    expect(t).toContain("per your project rules");
    expect(t).not.toContain("fuse-ai-pilot");
    expect(t).not.toContain("CLAUDE.md");
  }
});

test("release gate action line: Claude unchanged, other hosts use bare agent names", () => {
  expect(reviewActionLine()).toBe("Run fuse-ai-pilot:sniper then fuse-ai-pilot:challenger, then retry");
  expect(reviewActionLine("claude-code")).toBe("Run fuse-ai-pilot:sniper then fuse-ai-pilot:challenger, then retry");
  for (const id of ["codex", "kimi", "cursor"]) expect(reviewActionLine(id)).toBe("Run sniper then challenger, then retry");
});

// --- skill paths: resolved at runtime from the running host's own install -----------------------

test("discoverRefs: a host scans its own install first (Codex cache under any marketplace); Claude output unchanged", () => {
  const home = tmp();
  const cwd = tmp();
  const claude = mkSkill(join(home, ".claude", "plugins", "marketplaces", "m", "plugins", "react-expert", "skills"), "solid-react");
  const codex = mkSkill(join(home, ".codex", "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills"), "solid-react");
  const env = {};
  expect(discoverRefs(home, cwd, ["m"], undefined, env).split(delimiter)).toEqual([claude]);
  expect(discoverRefs(home, cwd, ["m"], "claude-code", env).split(delimiter)).toEqual([claude]);
  expect(discoverRefs(home, cwd, ["m"], "codex", env).split(delimiter)).toEqual([codex]);
  // $CODEX_HOME relocates the Codex install.
  const alt = tmp();
  const moved = mkSkill(join(alt, "plugins", "cache", "x", "p", "2.0.0", "skills"), "solid-react");
  expect(discoverRefs(home, cwd, ["m"], "codex", { CODEX_HOME: alt }).split(delimiter)).toEqual([moved]);
  // A host with no install of its own keeps the shared fallback (the gate stays on).
  expect(discoverRefs(home, cwd, ["m"], "kimi", env).split(delimiter)).toEqual([claude]);
});

function gateCtx(refs: RefMeta[], hostId: string | undefined): ApexContext {
  return { hostId, sessionId: "s", framework: "tanstack-start", filePath: "/p/src/routes/a.tsx", content: "", refs };
}

test("APEX documentation gate: Codex is shown its own skill path; Claude message unchanged", () => {
  const home = tmp();
  const codexRefs = mkSkill(join(home, ".codex", "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills"), "solid-react");
  const claudeRefs = mkSkill(join(home, ".claude", "plugins", "marketplaces", "m", "plugins", "react-expert", "skills"), "solid-react");
  const mk = (dir: string): RefMeta[] => [ref(join(dir, "a.md"), "a", "principle"), ref(join(dir, "b.md"), "b", "template")];

  const onCodex = apexAuthorizationGate(gateCtx(mk(codexRefs), "codex"));
  expect(onCodex?.reason).toContain(`Full skill: ${join(codexRefs, "..", "SKILL.md").replace(/\/references\/\.\./, "")}`);
  expect(onCodex?.reason).not.toContain(".claude");

  const onClaude = apexAuthorizationGate(gateCtx(mk(claudeRefs), "claude-code"));
  expect(onClaude?.reason).toContain(`Full skill: ${join(claudeRefs, "..", "SKILL.md")}`);
  expect(apexAuthorizationGate(gateCtx(mk(claudeRefs), undefined))?.reason).toBe(onClaude?.reason as string);
});

test("getSkillSource: Codex resolves in its own install (CODEX_HOME), else a real discovered path, else the context7 consigne", () => {
  const codexHome = tmp();
  const kimiHome = tmp();
  const prev = { codex: process.env.CODEX_HOME, kimi: process.env.KIMI_CODE_HOME };
  process.env.CODEX_HOME = codexHome;
  process.env.KIMI_CODE_HOME = kimiHome;
  try {
    mkSkill(join(codexHome, "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills"), "react-19");
    // Skill present in the Codex install → that real, existing path.
    const found = getSkillSource("react", undefined, "codex");
    expect(found).toBe(join(codexHome, "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills", "react-19", "SKILL.md"));
    // Skill absent from the Kimi install and from the (empty) shared marketplace → context7 consigne.
    const emptyMarketplace = tmp();
    expect(getSkillSource("react", emptyMarketplace, "kimi")).toBe("mcp__context7__query-docs");
    // Absent from Kimi's install but present in the shared marketplace → that real, existing path.
    const shared = tmp();
    mkSkill(join(shared, "react-expert", "skills"), "react-19");
    expect(getSkillSource("react", shared, "kimi")).toBe(join(shared, "react-expert", "skills", "react-19", "SKILL.md"));
  } finally {
    if (prev.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.codex;
    if (prev.kimi === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev.kimi;
  }
});

import { test, expect } from "bun:test";
import { delimiter, join } from "node:path";
import { writeFileSync } from "node:fs";
import { refsDirFor } from "../src/refs/refs-override";
import { loadRefs } from "../src/refs/loader";
import { solidReadGate } from "../src/policy/apex";
import { messageHost } from "../src/policy/host-skill-paths";
import { postEditContext } from "../src/runtime/lifecycle-bridge";
import { fakeHome, mkSkill, tmp } from "./host-aware-fixtures";

// Real-layout fake homes are built under a temp dir and passed explicitly (never the real home).
const HOME = fakeHome();
const REFS_MD = "---\nname: x\napplies-to: \"**/*.ts\"\nlevel: principle\n---\n# x\n";
const LAYOUT: Record<string, string> = {
  "claude-code": join(HOME, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins", "solid", "skills"),
  codex: join(HOME, ".codex", "plugins", "cache", "fusengine-codex", "solid", "1.0.33", "skills"),
  kimi: join(HOME, ".kimi-code", "plugins", "managed", "fusengine", "plugins", "solid", "skills"),
  cursor: join(HOME, ".cursor", "plugins", "cache", "fusengine-cursor-plugins", "fuse-solid", "cc6349f", "skills"),
};
for (const dir of Object.values(LAYOUT)) {
  const refs = mkSkill(dir, "solid-generic");
  for (const f of ["architecture-patterns.md", "single-responsibility.md", "solid-principles.md"]) writeFileSync(join(refs, f), REFS_MD);
}
const MKTS = ["fusengine-plugins", "fusengine-codex"];

test("F1 live case: generic .ts edit, FUSE_HARNESS_REFS inherited from a Claude session → each host still gets ITS OWN refs; reading them clears", async () => {
  const inherited = join(LAYOUT["claude-code"]!, "solid-generic", "references");
  const env = { FUSE_HARNESS_REFS: inherited };
  for (const id of ["codex", "kimi", "cursor"]) {
    const dir = refsDirFor(HOME, "/tmp/nowhere", MKTS, id, env);
    expect(dir).not.toContain(".claude");
    const ctx = { hostId: id, sessionId: "s", framework: "generic", filePath: "/p/src/util.ts", content: "export const a = 1;", refs: await loadRefs(dir as string) };
    const deny = solidReadGate(ctx);
    expect(deny?.kind).toBe("block");
    expect(deny?.reason).not.toContain(".claude");
    expect(deny?.reason).toContain("Full skill:");
    expect(JSON.stringify(deny?.actions)).not.toContain(".claude");
    expect(solidReadGate({ ...ctx, refsRead: deny?.actions })).toBeNull();
  }
});

test("F1: the FUSE_HARNESS_REFS override is untouched for Claude Code and when it points inside the host's own tree", () => {
  const claudeRefs = join(LAYOUT["claude-code"]!, "solid-generic", "references");
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, "claude-code", { FUSE_HARNESS_REFS: claudeRefs })).toBe(claudeRefs);
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, undefined, { FUSE_HARNESS_REFS: claudeRefs })).toBe(claudeRefs);
  const own = join(LAYOUT["codex"]!, "solid-generic", "references");
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, "codex", { FUSE_HARNESS_REFS: own })).toBe(own);
  const custom = tmp();
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, "codex", { FUSE_HARNESS_REFS: custom })).toBe(custom);
  // Only an override made EXCLUSIVELY of ~/.claude entries is dropped; a mixed list is honoured as before.
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, "codex", { FUSE_HARNESS_REFS: [claudeRefs, custom].join(delimiter) })).toBe([claudeRefs, custom].join(delimiter));
});

test("F1 weakening guard: a non-home .claude override with NO host refs keeps the gate ON (as base); a home-.claude override with no refs anywhere is kept too", async () => {
  const empty = tmp(); // a home with no skills at all: discovery finds nothing
  const teamRoot = tmp();
  const teamRefs = mkSkill(join(teamRoot, ".claude"), "solid-generic");
  for (const f of ["architecture-patterns.md", "single-responsibility.md"]) writeFileSync(join(teamRefs, f), REFS_MD);
  for (const id of ["codex", "kimi", "cursor"]) {
    // Not under <home>/.claude, and the host has nothing: the override is used exactly as on base.
    const dir = refsDirFor(empty, "/tmp/nowhere", MKTS, id, { FUSE_HARNESS_REFS: teamRefs });
    expect(dir).toBe(teamRefs);
    const refs = await loadRefs(dir as string);
    const deny = solidReadGate({ hostId: id, sessionId: "s", framework: "generic", filePath: "/p/src/util.ts", content: "export const a = 1;", refs });
    expect(deny?.kind).toBe("block");
    // Even an override under <home>/.claude survives when discovery finds nothing at all.
    const homeClaude = join(empty, ".claude", "x", "references");
    expect(refsDirFor(empty, "/tmp/nowhere", MKTS, id, { FUSE_HARNESS_REFS: homeClaude })).toBe(homeClaude);
  }
  // A non-home .claude override is NOT dropped even when the host has refs of its own (it is not the inherited ~/.claude one).
  expect(refsDirFor(HOME, "/tmp/nowhere", MKTS, "codex", { FUSE_HARNESS_REFS: teamRefs })).toBe(teamRefs);
});

test("F2: a claude-code invocation is resolved as cursor only with CURSOR_VERSION and no Claude Code markers", () => {
  expect(messageHost("claude-code", { CURSOR_VERSION: "3.2.1" })).toBe("cursor");
  expect(messageHost("claude-code", { CURSOR_VERSION: "3.2.1", CLAUDECODE: "1" })).toBe("claude-code");
  expect(messageHost("claude-code", { CURSOR_VERSION: "3.2.1", CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("claude-code");
  expect(messageHost("claude-code", {})).toBe("claude-code");
  expect(messageHost("claude-code", { CURSOR_VERSION: "  " })).toBe("claude-code");
  expect(messageHost("codex", { CURSOR_VERSION: "3.2.1" })).toBe("codex");
  expect(messageHost("cursor", { CURSOR_VERSION: "3.2.1" })).toBe("cursor");
});

test("F2: the sniper reminder of a claude-code invocation under Cursor names cursor's wording; real Claude Code stays byte-identical", async () => {
  const keep = { cv: process.env.CURSOR_VERSION, cc: process.env.CLAUDECODE, ep: process.env.CLAUDE_CODE_ENTRYPOINT };
  const root = tmp();
  const file = join(root, "button.tsx");
  writeFileSync(file, "export const a = 1;\n");
  const text = async (sid: string): Promise<string> => {
    const out = await postEditContext("core", { tool: "Write", filePath: file, sessionId: sid, cwd: root } as never, Date.now(), "claude-code", root);
    return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  };
  try {
    delete process.env.CURSOR_VERSION;
    expect(await text("f2-claude")).toContain("(fuse-ai-pilot:sniper)");
    process.env.CURSOR_VERSION = "3.2.1";
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    const underCursor = await text("f2-cursor");
    expect(underCursor).toContain("run the sniper agent (sniper)");
    expect(underCursor).not.toContain("fuse-ai-pilot");
  } finally {
    for (const [k, v] of [["CURSOR_VERSION", keep.cv], ["CLAUDECODE", keep.cc], ["CLAUDE_CODE_ENTRYPOINT", keep.ep]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { apexAuthorizationGate } from "../src/policy/apex-authorization";
import { solidReadGate } from "../src/policy/apex";
import { apexDocName, hostRulesRef } from "../src/policy/apex-target";
import { evaluateFileSize, PLUGINS_DIR } from "../src/policy/file-size";
import { discoverRefs } from "../src/refs/discover";
import { solidFileSizeGate } from "../src/runtime/solid-file-size-gate";
import type { RefMeta } from "../src/refs/types";
import { mkSkill, ref, tmp } from "./host-aware-fixtures";

const refsOf = (dir: string): RefMeta[] => [ref(join(dir, "a.md"), "a", "principle"), ref(join(dir, "b.md"), "b", "template")];

test("A: Kimi/Cursor with only ~/.claude refs → the deny lists the real paths and clears after reading them", () => {
  const home = tmp();
  const claudeRefs = mkSkill(join(home, ".claude", "plugins", "marketplaces", "m", "plugins", "react-expert", "skills"), "solid-react");
  for (const id of ["kimi", "cursor"]) {
    const ctx = { hostId: id, sessionId: "s", framework: "react", filePath: "/p/src/a.tsx", content: "", refs: refsOf(claudeRefs), authorizations: { react: { doc_sessions: ["s"], sources: ["context7", "exa"] } } };
    const deny = apexAuthorizationGate({ ...ctx, authorizations: undefined });
    expect(deny?.actions).toEqual([join(claudeRefs, "a.md"), join(claudeRefs, "b.md")]);
    expect(deny?.reason).toContain(`Full skill: ${claudeRefs.replace(/\/references$/, "")}/SKILL.md`);
    // Same as base: the SOLID-read gate demands exactly those files and clears once they are read.
    const gate = solidReadGate(ctx);
    expect(gate?.kind).toBe("block");
    expect(gate?.actions).toEqual(deny?.actions as string[]);
    expect(solidReadGate({ ...ctx, refsRead: gate?.actions })).toBeNull();
  }
});

test("A: a skill path that does not exist is never printed", () => {
  const home = tmp();
  const refs = mkSkill(join(home, ".claude", "plugins", "marketplaces", "m", "plugins", "react-expert", "skills"), "solid-react");
  const list = refsOf(refs).map((r) => ({ ...r, filePath: r.filePath.replace("solid-react", "solid-gone") }));
  const deny = apexAuthorizationGate({ hostId: "kimi", sessionId: "s", framework: "react", filePath: "/p/src/a.tsx", content: "", refs: list });
  expect(deny?.reason).not.toContain("Full skill:");
});

test("B: file-size deny: Claude unchanged; Codex/Kimi get an existing host path or neutral text, never ~/.claude", () => {
  const claude = evaluateFileSize(300, 200, "/p/a.tsx", "react", 300, "", "");
  expect(claude.message).toContain(`Read SOLID rules: ${PLUGINS_DIR}/react-expert/skills/solid-react/ `);
  expect(evaluateFileSize(300, 200, "/p/a.tsx", "react", 300, "", "", "claude-code").message).toBe(claude.message as string);

  const codexHome = tmp();
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const own = mkSkill(join(codexHome, "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills"), "solid-react");
    const onCodex = evaluateFileSize(300, 200, "/p/a.tsx", "react", 300, "", "", "codex");
    expect(onCodex.message).toContain(`Read SOLID rules: ${own.replace(/\/references$/, "")}/ `);
    expect(onCodex.message).not.toContain("~/.claude");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
  // No skill of its own: a real existing path, or neutral wording; never the phantom `~/.claude` string.
  const onKimi = evaluateFileSize(300, 200, "/p/a.tsx", "generic", 300, "", "", "kimi").message as string;
  expect(onKimi).not.toContain("~/.claude");
  const printed = /Read SOLID rules: (\/\S+) /.exec(onKimi)?.[1];
  if (printed) expect(existsSync(printed)).toBe(true);
});

test("B2: solid-scope file-size deny: Claude unchanged; Codex never gets ~/.claude (own skill, else a real existing path)", () => {
  const big = `${"export const x = 1;\n".repeat(400)}`;
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
  const file = join(root, "src", "big.tsx");
  const claude = solidFileSizeGate("Write", file, big)?.reason as string;
  expect(claude).toContain(`Read SOLID rules: ${PLUGINS_DIR}/react-expert/skills/solid-react/ `);
  expect(solidFileSizeGate("Write", file, big, undefined, false, undefined, "claude-code")?.reason).toBe(claude);

  const codexHome = tmp();
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const own = mkSkill(join(codexHome, "plugins", "cache", "fusengine-codex", "react-expert", "1.0.0", "skills"), "solid-react");
    const onCodex = solidFileSizeGate("Write", file, big, undefined, false, undefined, "codex")?.reason as string;
    expect(onCodex).toContain(`Read SOLID rules: ${own.replace(/\/references$/, "")}/ `);
    expect(onCodex).not.toContain("~/.claude");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
  // Codex without the skill: a real existing path or neutral wording, never the phantom string.
  const empty = tmp();
  process.env.CODEX_HOME = empty;
  try {
    const bare = solidFileSizeGate("Write", file, big, undefined, false, undefined, "codex")?.reason as string;
    expect(bare).not.toContain("~/.claude");
    const printed = /Read SOLID rules: (\/\S+) /.exec(bare)?.[1];
    if (printed) expect(existsSync(printed)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test("C: one rules-file table: apexDocName and hostRulesRef agree wherever the host has a proven rules doc", () => {
  for (const id of ["claude-code", "codex", "kimi"]) expect(hostRulesRef(id)).toBe(`${apexDocName(id)} rules`);
  expect(apexDocName("claude-code")).toBe("CLAUDE.md");
  expect(apexDocName("codex")).toBe("AGENTS.md");
  expect(apexDocName("kimi")).toBe("AGENTS.md");
  // Cursor: its global rules live in ~/.cursor/rules/*.mdc (no CLAUDE.md/AGENTS.md at home): neutral wording.
  for (const id of ["cursor", "cline", "gemini-cli", "hermes"]) expect(hostRulesRef(id)).toBe("your project rules");
});

test("D: several versions in a plugin cache → the highest semver wins (1.0.100 over 1.0.39), Claude and Codex", () => {
  const home = tmp();
  const cwd = tmp();
  for (const [seg, mkt] of [[".claude", "m"], [".codex", "fusengine-codex"]] as const) {
    const base = join(home, seg, "plugins", "cache", mkt, "react-expert");
    mkSkill(join(base, "1.0.39", "skills"), "solid-react");
    const latest = mkSkill(join(base, "1.0.100", "skills"), "solid-react");
    mkSkill(join(base, "1.0.9", "skills"), "solid-react");
    const id = seg === ".codex" ? "codex" : "claude-code";
    expect(discoverRefs(home, cwd, ["m", "fusengine-codex"], id, {}).split(delimiter)).toEqual([latest]);
  }
});

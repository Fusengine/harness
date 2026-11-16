import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { prdPreGate } from "../../../src/runtime/prd/prd-pre-gate";
import { normalizeEvent } from "../../../src/runtime/normalize";
import type { NormalizedEvent } from "../../../src/runtime/normalize";
import { prdAgentReportPath, prdRouterPath } from "../../../src/policy/prd";
import { harnessHomeSegment } from "../../../src/policy/apex-target";
import { setupPrdEnv, type PrdTestEnv } from "./env";
import { bashEvent, denyReason, isDenied } from "./prd-pre-gate-helpers";

const NOW = 1_700_000_000_000;

function write(id: string, sid: string, file: string, cwd?: string): NormalizedEvent {
  return normalizeEvent(id, { hook_event_name: id === "cursor" ? "preToolUse" : "PreToolUse", tool_name: "Write", session_id: sid, ...(cwd ? { cwd } : {}), tool_input: { file_path: file, content: "{}" } });
}
function patch(id: string, sid: string, file: string, cwd?: string): NormalizedEvent {
  return normalizeEvent(id, { hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: sid, ...(cwd ? { cwd } : {}), tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+{}\n*** End Patch` } });
}

/** One gate run in an isolated env with FUSE_PRD=1. */
async function run(id: string, mk: (e: PrdTestEnv) => NormalizedEvent, mutate?: (e: PrdTestEnv) => void) {
  const env = setupPrdEnv(harnessHomeSegment(id));
  try {
    process.env.FUSE_PRD = "1";
    mutate?.(env);
    const out = await prdPreGate(id, {}, mk(env), env.root, env.trackFilePath, NOW);
    return { out, env, canonRoot: realpathSync(env.root), denied: out !== null && isDenied(out.stdout), reason: out ? denyReason(out.stdout) : "" };
  } finally {
    delete process.env.FUSE_PRD;
    env.restore();
  }
}

describe("outside-apex PRD report path — deny", () => {
  test("codex apply_patch Add File: prd/agents/x-prd.json", async () => {
    const r = await run("codex", (e) => patch("codex", e.sessionId, "prd/agents/x-prd.json"));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(`write your PRD report to ${prdAgentReportPath(r.canonRoot, ".codex", "x")}`);
  });
  test("codex, cwd = <root>/sub: relative patch path lands in sub/prd/agents -> deny", async () => {
    const r = await run("codex", (e) => patch("codex", e.sessionId, "prd/agents/x-prd.json", join(e.root, "sub")));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain("is outside");
  });
  test("claude Write <root>/prd/agents/x-prd.json", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, "prd/agents/x-prd.json")));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(prdAgentReportPath(r.env.root, ".claude", "x"));
  });
  for (const id of ["cursor", "kimi"]) {
    test(`${id} Write outside is denied (path rule, not identity)`, async () => {
      const r = await run(id, (e) => write(id, e.sessionId, join(e.root, "prd/agents/x-prd.json")));
      expect(r.denied).toBe(true);
    });
    test(`${id} relative Write resolved against payload cwd`, async () => {
      const r = await run(id, (e) => write(id, e.sessionId, "prd/agents/x-prd.json", e.root));
      expect(r.denied).toBe(true);
    });
  }
  test("Bash redirect", async () => {
    const r = await run("claude-code", (e) => bashEvent("claude-code", e.sessionId, "echo {} > prd/agents/x-prd.json"));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain("is outside");
  });
  test("Bash `&>` redirect (extended form)", async () => {
    const r = await run("claude-code", (e) => bashEvent("claude-code", e.sessionId, "echo x &> prd/agents/x-prd.json"));
    expect(r.denied).toBe(true);
  });
  test("symlinked home segment: the correct apex path is never denied as outside", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, ".claude/apex/prd/agents/x-prd.json")), (e) => {
      const real = join(e.root, "ext");
      mkdirSync(real);
      renameSync(join(e.root, ".claude"), join(real, ".claude-real"));
      symlinkSync(join(real, ".claude-real"), join(e.root, ".claude"));
    });
    expect(r.reason).not.toContain("is outside");
  });
  test("Bash cp verb", async () => {
    const r = await run("claude-code", (e) => bashEvent("claude-code", e.sessionId, "cp a prd/agents/x-prd.json"));
    expect(r.denied).toBe(true);
  });
  test("broken router + outside write -> still the new deny", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, "prd/agents/x-prd.json")), (e) => {
      writeFileSync(prdRouterPath(e.root, e.homeSeg), "{not json");
    });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain("is outside");
  });
});

describe("outside-apex PRD report path — never touched", () => {
  test("correct apex path: never the new deny", async () => {
    const r = await run("codex", (e) => patch("codex", e.sessionId, `${e.root}/.codex/apex/prd/agents/x-prd.json`));
    expect(r.reason).not.toContain("is outside");
  });
  test("anchored rule: only <root>/prd/agents or <cwd>/prd/agents are denied; every other lookalike falls through", async () => {
    const files = [
      "docs/prd/agents/notes.md", "prd/agents/x.json", "src/agents/x-prd.json",
      "test/fixtures/prd/prd/agents/backend-expert-prd.json", "docs/prd/agents/onboarding-prd.json",
      ".codex/apex/prd/agents/x-prd.json", // another host's tree, written from a claude session
    ];
    for (const f of files) {
      const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, f)));
      expect(r.out).toBeNull();
    }
  });
  test("cwd inside ANOTHER host's apex dir: its real reports folder is not the bug shape", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, "prd/agents/a-prd.json", join(e.root, ".codex/apex")));
    expect(r.out).toBeNull();
  });
  test("a backup tree outside the project (/tmp/bk/prd/agents/x-prd.json) is untouched", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, "..", "bk-outside", "prd/agents/x-prd.json")));
    expect(r.out).toBeNull();
  });
  test("deletes are not writes: apply_patch Delete File of the bug's leftover is allowed", async () => {
    const r = await run("codex", (e) => normalizeEvent("codex", { hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: e.sessionId, tool_input: { command: "*** Begin Patch\n*** Delete File: prd/agents/x-prd.json\n*** End Patch" } }));
    expect(r.out).toBeNull();
  });
  test("router absent: inert", async () => {
    const r = await run("claude-code", (e) => write("claude-code", e.sessionId, join(e.root, "prd/agents/x-prd.json")), (e) => rmSync(prdRouterPath(e.root, e.homeSeg)));
    expect(r.out).toBeNull();
  });
  test("FUSE_PRD unset: inert", async () => {
    const env = setupPrdEnv(".claude");
    try {
      delete process.env.FUSE_PRD;
      const out = await prdPreGate("claude-code", {}, write("claude-code", env.sessionId, join(env.root, "prd/agents/x-prd.json")), env.root, env.trackFilePath, NOW);
      expect(out).toBeNull();
    } finally { env.restore(); }
  });
});

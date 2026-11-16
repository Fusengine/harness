import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prdPreGate } from "../../../src/runtime/prd/prd-pre-gate";
import { resolvePrdIdentity } from "../../../src/runtime/prd/prd-identity";
import { normalizeEvent } from "../../../src/runtime/normalize";
import { handleHook } from "../../../src/runtime/handle";
import { loadTrack } from "../../../src/tracking/store";
import { prdAgentReportPath, prdRouterPath } from "../../../src/policy/prd";
import { reopenFixtureSlot, setupPrdEnv } from "./env";
import { bashEvent, denyReason, isDenied, writeEvent } from "./prd-pre-gate-helpers";

const NOW = 1_700_000_000_000;

describe("B0 — inertia", () => {
  test("flag absent, router present: prdPreGate is inert; handleHook falls through to protectedPathGuard's SAME deny", async () => {
    const env = setupPrdEnv();
    try {
      delete process.env.FUSE_PRD;
      const filePath = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const event = normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: "Write", session_id: env.sessionId, tool_input: { file_path: filePath, content: "{}" } });
      expect(await prdPreGate("claude-code", {}, event, env.root, env.trackFilePath, NOW)).toBeNull();
      const out = await handleHook("claude-code", { hook_event_name: "PreToolUse", tool_name: "Write", session_id: env.sessionId, tool_input: { file_path: filePath, content: "{}" } }, { now: NOW, cwd: env.root });
      expect(denyReason(out.stdout)).toContain("internal/generated enforcement state"); // protectedPathGuard's own message, untouched by PRD
      expect(denyReason(out.stdout)).not.toContain("PRD");
    } finally {
      env.restore();
    }
  });

  test("flag=1, router absent: same inert fallthrough", async () => {
    const env = setupPrdEnv();
    rmSync(prdRouterPath(env.root, env.homeSeg));
    try {
      process.env.FUSE_PRD = "1";
      const filePath = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const event = normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: "Write", session_id: env.sessionId, tool_input: { file_path: filePath, content: "{}" } });
      expect(await prdPreGate("claude-code", {}, event, env.root, env.trackFilePath, NOW)).toBeNull();
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

describe("B1 — identity resolution + first-write binding", () => {
  test("real capture: normalizeEvent + resolvePrdIdentity populate agentId/agentType from the authentic Claude sub-agent Write", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "..", "fixtures", "prd", "authentic", "claude", "pretooluse-subagent-write.json"), "utf8")) as { stdin: Record<string, unknown> };
    const event = normalizeEvent("claude-code", fixture.stdin);
    expect(event.agentId).toBe("agent0000000000001");
    expect(event.agentType).toBe("general-purpose");
    expect(resolvePrdIdentity("claude-code", event)).toEqual({ lead: false, agentId: "agent0000000000001", agentType: "general-purpose" });
  });

  test("first write from a sub-agent binds its own report file; a 2nd distinct filename from the SAME agent is denied", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1"; reopenFixtureSlot(env.root, env.homeSeg);
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const out1 = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target, "a1", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(out1).not.toBeNull();
      expect(out1!.stdout).not.toContain("permissionDecision\":\"deny");
      const track = await loadTrack(env.trackFilePath);
      expect(track.prdOwners).toEqual({ a1: "backend-expert" });

      const other = prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");
      const out2 = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, other, "a1", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(out2).not.toBeNull();
      expect(denyReason(out2!.stdout)).toContain(other);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("a second agent_id trying an ALREADY-bound filename is denied", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1"; reopenFixtureSlot(env.root, env.homeSeg);
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target, "a1", "backend-expert"), env.root, env.trackFilePath, NOW);
      const out2 = await prdPreGate("claude-code", {}, writeEvent(env.sessionId, target, "a2", "backend-expert"), env.root, env.trackFilePath, NOW);
      expect(out2).not.toBeNull();
      expect(denyReason(out2!.stdout)).toContain(target);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

describe("B1c — Bash write-verb detection beyond redirects (cp/mv/tee/sed -i/install/dd of=)", () => {
  test("RED->GREEN witness: `cp` (no redirect) to another agent's report on codex is denied", async () => {
    const env = setupPrdEnv(".codex");
    try {
      process.env.FUSE_PRD = "1";
      const foreign = prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");
      const event = bashEvent("codex", env.sessionId, `cp /etc/hosts ${foreign}`, "a1", "backend-expert");
      const out = await prdPreGate("codex", {}, event, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(denyReason(out!.stdout)).toContain("never Bash");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("positive witness per verb (options skipped) + chaining/substitution/quoting all deny the SAME in-scope target", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const t = prdAgentReportPath(env.root, env.homeSeg, "backend-expert-2");
      const commands = [
        `cp -r /etc ${t}`, `cp -a --force /etc/hosts ${t}`, `mv /etc/hosts ${t}`, `tee -a ${t}`,
        `sed -i.bak -e s/x/y/ ${t}`, `install -m 644 /etc/hosts ${t}`, `dd if=/etc/hosts of=${t}`,
        `echo hi && cp /etc/hosts ${t}`, `echo $(cp /etc/hosts ${t})`, `cp /etc/hosts '${t}'`, `cp /etc/hosts "${t}"`,
        // Regression (sniper-found): bash still runs command substitution
        // INSIDE double quotes (only single quotes suppress it) — the verb
        // must still be found when `$(...)`/backticks are wrapped in `"..."`.
        `echo "$(cp /etc/hosts ${t})"`, `echo "text \`cp /etc/hosts ${t}\` more"`,
      ];
      for (const command of commands) {
        const out = await prdPreGate("claude-code", {}, bashEvent("claude-code", env.sessionId, command), env.root, env.trackFilePath, NOW);
        expect(out).not.toBeNull();
        expect(out!.stdout).toContain("Bash");
      }
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("Bash write-verb rule is UNCONDITIONAL (not the ownership advisory split): Cursor is denied too", async () => {
    const env = setupPrdEnv(".cursor");
    try {
      process.env.FUSE_PRD = "1";
      const target = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const event = normalizeEvent("cursor", { hook_event_name: "preToolUse", session_id: env.sessionId, tool_input: { command: `cp /etc/hosts ${target}` } });
      const out = await prdPreGate("cursor", {}, event, env.root, env.trackFilePath, NOW);
      expect(out).not.toBeNull();
      expect(isDenied(out!.stdout)).toBe(true);
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("non-interference (pinned to pre-extension null) + known false-positive traps never fire", async () => {
    const env = setupPrdEnv();
    try {
      process.env.FUSE_PRD = "1";
      const inScope = prdAgentReportPath(env.root, env.homeSeg, "backend-expert"); // in-scope, but never a WRITE target below
      const commands = [
        "cp src/a.ts src/b.ts", "mv build/x build/y", "echo x | tee /tmp/log", "sed -i.bak s/a/b/ package.json",
        "echo hi && cp src/a.ts src/b.ts", "echo $(cp src/a.ts src/b.ts)",
        `cp ${inScope} /tmp/other.json /out/of/scope/dir`, // multi-source + target dir; a SOURCE is in-scope, the real target isn't
        `cat ${inScope} | tee`, // no positional arg: writes to stdout only
        `sed s/x/y/ ${inScope}`, // no -i: prints to stdout, never edits in place
        "install -m 644 /etc/hosts", // missing dest — "644" ends up last, but never resolves under apex/prd/
      ];
      for (const command of commands) {
        const out = await prdPreGate("claude-code", {}, bashEvent("claude-code", env.sessionId, command), env.root, env.trackFilePath, NOW);
        expect(out).toBeNull(); // manually A/B-verified identical to the pre-extension code — see PR report
      }
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("REGRESSION (challenger): protected-path file in an apply_patch envelope — witness E (alone, denied) then case F (mixed with an OWNED report, never bypassed, still denied end-to-end)", async () => {
    const env = setupPrdEnv(".codex"); // literal ".claude/apex/" fragment below is homeSeg-independent (protectedPathGuard is a hardcoded string match, not harnessHomeSegment-aware — the gap this witness proves)
    try {
      process.env.FUSE_PRD = "1";
      const protectedFile = join(env.root, ".claude", "apex", "tasks.json");
      const soloPayload = {
        hook_event_name: "PreToolUse", session_id: env.sessionId, agent_id: "a1", agent_type: "backend-expert", tool_name: "apply_patch",
        tool_input: { command: `*** Begin Patch\n*** Add File: ${protectedFile}\n+{}\n*** End Patch\n` },
      };
      const solo = await handleHook("codex", soloPayload, { now: NOW, cwd: env.root }); // witness E: alone, must be denied (else the probe is dead)
      expect(denyReason(solo.stdout)).toContain("internal/generated enforcement state");

      reopenFixtureSlot(env.root, env.homeSeg);
      const own = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const mixedPayload = {
        hook_event_name: "PreToolUse", session_id: env.sessionId, agent_id: "a1", agent_type: "backend-expert", tool_name: "apply_patch",
        tool_input: { command: `*** Begin Patch\n*** Add File: ${own}\n+x\n*** Add File: ${protectedFile}\n+{}\n*** End Patch\n` },
      };
      const unit = await prdPreGate("codex", {}, normalizeEvent("codex", mixedPayload), env.root, env.trackFilePath, NOW);
      expect(unit).toBeNull(); // case F: never short-circuits an allow that would carry the protected file with it
      const full = await handleHook("codex", mixedPayload, { now: NOW, cwd: env.root });
      expect(denyReason(full.stdout)).toContain("internal/generated enforcement state"); // end-to-end: the normal chain still denies it
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

/**
 * @module test/runtime/prd/prd-stop-compact-hint
 * B6 — post-validation compact hint on the lead Stop gate. Split out of
 * prd-stop-gate.test.ts to stay under the repo's 200-line file ceiling.
 *
 * Target-agnostic by design: `compactReminder` (`prd-stop-gate.ts`) carries
 * NO id allowlist — it mirrors the SAME per-target form choice as the block
 * path directly below it (kimi/gemini-cli/cline via `respond()`'s native
 * "inform" envelope, everyone else via the `Stop` `additionalContext`
 * channel). Whether it is ever REACHED for a given id in production is a
 * wiring question, not something this function should gatekeep: measured
 * live against the real hooks.json this project ships (claude-plugins/
 * codex-plugins/kimi-code-plugins) plus each target's own hook docs:
 * Codex's Stop wiring is a plain `hook codex core` with no short-circuit;
 * claude-code's core-guards hooks.json carries a second Stop entry WITHOUT
 * `--sound` that reaches `prdStopGate` via `src/runtime/lifecycle/dispatch.ts`
 * (the `--sound stop` entry only plays the sound in `maybePlaySound()`);
 * Kimi's Stop hook carries `--sound stop`, which exits in `maybePlaySound()`
 * (`src/cli/hook-sound.ts`) before stdin is ever read, and
 * hermes/gemini-cli/cline have no event literally named
 * `Stop` in their own documented hook taxonomy at all. See prd.md's Known
 * limitations for the full measurement.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { prdStopGate } from "../../../src/runtime/prd/prd-stop-gate";
import { prdRouterPath, prdTaskPath } from "../../../src/policy/prd";
import { setupPrdEnv } from "./env";

const NOW = 1_700_000_000_000;

/** `auth-refactor`, both agents fully validated but not yet compacted — docs/prd.md's walkthrough step 9-10 state, just before `compact`. */
function seedCompactable(root: string, homeSeg: string): void {
  writeFileSync(prdRouterPath(root, homeSeg), JSON.stringify({ "auth-refactor": { prd: "prd/auth-refactor-prd.json", status: "validated" } }));
  writeFileSync(prdTaskPath(root, homeSeg, "prd/auth-refactor-prd.json"), JSON.stringify({
    "backend-expert": { files: ["src/auth/login.ts"], "sub-tasks": { "jwt-validation": { status: "validated", "validated-at": "t0" } } },
    "backend-expert-2": { files: ["src/auth/session.ts"], "sub-tasks": { "session-store": { status: "validated", "validated-at": "t0" } } },
  }));
}

describe("B6 — post-validation compact hint (target-agnostic, mirrors the block path's per-target form)", () => {
  test("Codex: a fully-validated, not-yet-compacted task names itself and the exact compact command, once per session", () => {
    const env = setupPrdEnv(".codex");
    try {
      process.env.FUSE_PRD = "1";
      seedCompactable(env.root, env.homeSeg);
      const payload = { session_id: env.sessionId };
      const first = prdStopGate(payload, env.root, "codex", env.trackFilePath, NOW);
      const parsed = JSON.parse(first);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("auth-refactor");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("harness prd compact auth-refactor");

      const replay = prdStopGate(payload, env.root, "codex", env.trackFilePath, NOW + 1000);
      expect(replay).toBe("");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test.each([
    ["claude-code", ".claude", (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext.includes("auth-refactor")],
    ["hermes", ".hermes", (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext.includes("auth-refactor")],
    ["kimi", ".kimi-code", (out: string) => out.includes("auth-refactor")], // toKimiResponse's "inform" branch: raw text, no JSON envelope
    ["gemini-cli", ".gemini", (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext.includes("auth-refactor")],
    ["cline", ".clinerules", (out: string) => JSON.parse(out).contextModification.includes("auth-refactor")],
  ] as const)(
    "%s: mirrors the block path's own native form for the SAME compactable state (no id allowlist)",
    (id, homeSeg, matchesTask) => {
      const env = setupPrdEnv(homeSeg);
      try {
        process.env.FUSE_PRD = "1";
        seedCompactable(env.root, env.homeSeg);
        const out = prdStopGate({ session_id: env.sessionId }, env.root, id, env.trackFilePath, NOW);
        expect(out).not.toBe("");
        expect(matchesTask(out)).toBe(true);
      } finally {
        delete process.env.FUSE_PRD;
        env.restore();
      }
    },
  );

  test("nothing compactable (fixture default, sub-tasks still 'assigned') stays silent regardless of id", () => {
    const env = setupPrdEnv(".codex");
    try {
      process.env.FUSE_PRD = "1";
      expect(prdStopGate({ session_id: env.sessionId }, env.root, "codex", env.trackFilePath, NOW)).toBe("");
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });

  test("never fires while a real violation is pending (block path takes priority, byte-identical)", () => {
    const env = setupPrdEnv(".codex");
    try {
      process.env.FUSE_PRD = "1";
      writeFileSync(prdRouterPath(env.root, env.homeSeg), JSON.stringify({ "auth-refactor": { prd: "prd/auth-refactor-prd.json", status: "validated" } }));
      const out = prdStopGate({ session_id: env.sessionId }, env.root, "codex", env.trackFilePath, NOW);
      expect(JSON.parse(out)).toMatchObject({ decision: "block" });
    } finally {
      delete process.env.FUSE_PRD;
      env.restore();
    }
  });
});

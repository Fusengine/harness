import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { runPrdValidate } from "../../src/cli/prd/validate";
import { prdStopGate } from "../../src/runtime/prd/prd-stop-gate";
import { capture } from "../cli/prd-fixtures";
import {
  NOW, SCHEMA_BAD, SYNTAX_BAD, VALID, allowed, claudeEvent, denyReason, gate, isDenied, patchEvent,
  prdAgentReportPath, routerPatch, withRouter,
} from "./helpers";

describe("recovery: coordinator repairs a broken router (case 1)", () => {
  test("codex apply_patch in_progress -> in-progress on a schema-invalid router is allowed", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const out = await gate("codex", env, patchEvent(env, routerPatch(env, SCHEMA_BAD, VALID)));
      expect(allowed(out)).toBe(true);
    }));

  test("codex apply_patch fixing a SYNTAX-invalid router is allowed", () =>
    withRouter(".codex", SYNTAX_BAD, async (env) => {
      const out = await gate("codex", env, patchEvent(env, routerPatch(env, SYNTAX_BAD, VALID)));
      expect(allowed(out)).toBe(true);
    }));

  test("claude Edit in_progress -> in-progress is allowed", () =>
    withRouter(".claude", SCHEMA_BAD, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Edit", { file_path: router, old_string: "in_progress", new_string: "in-progress" }));
      expect(allowed(out)).toBe(true);
    }));

  test("claude Write of a valid router over a broken one is allowed", () =>
    withRouter(".claude", SYNTAX_BAD, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: router, content: VALID }));
      expect(allowed(out)).toBe(true);
    }));
});

describe("recovery: no exception when the result is still invalid or cannot be derived (case 2)", () => {
  test("Write leaving the router schema-invalid is denied and names the schema error", () =>
    withRouter(".claude", SCHEMA_BAD, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: router, content: SCHEMA_BAD }));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("in_progress");
    }));

  test("Write leaving the router syntax-invalid is denied and names the parse error", () =>
    withRouter(".claude", SCHEMA_BAD, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: router, content: SYNTAX_BAD }));
      expect(denyReason(out!.stdout)).toContain("malformed JSON");
    }));

  test("Edit whose old_string is absent: post-write content underivable -> denied with a clear reason", () =>
    withRouter(".claude", SCHEMA_BAD, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Edit", { file_path: router, old_string: "nope", new_string: "x" }));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("cannot determine");
    }));
});

describe("recovery: ownership (case 3) and scope (case 4)", () => {
  test("non-coordinator gets the coordinator-only text, never 'malformed JSON'", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const out = await gate("codex", env, patchEvent(env, routerPatch(env, SCHEMA_BAD, VALID), "backend-expert"));
      expect(denyReason(out!.stdout)).toContain("router is coordinator-only");
      expect(denyReason(out!.stdout)).not.toContain("malformed JSON");
    }));

  test("mixed patch router + another PRD file: no exception, diagnostic names the router state", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const report = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const patch = `*** Begin Patch\n*** Update File: ${env.homeSeg}/apex/prd.json\n@@\n-${SCHEMA_BAD}\n+${VALID}\n*** Add File: ${report}\n+{}\n*** End Patch`;
      const out = await gate("codex", env, patchEvent(env, patch));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("schema invalid");
    }));

  test("mixed patch router + unrelated non-PRD file: no exception", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const patch = `*** Begin Patch\n*** Update File: ${env.homeSeg}/apex/prd.json\n@@\n-${SCHEMA_BAD}\n+${VALID}\n*** Add File: notes.txt\n+hi\n*** End Patch`;
      expect(isDenied((await gate("codex", env, patchEvent(env, patch)))!.stdout)).toBe(true);
    }));

  test("another PRD path (agent report) while the router is broken: denied with the correct diagnostic", () =>
    withRouter(".claude", SYNTAX_BAD, async (env) => {
      const report = prdAgentReportPath(env.root, env.homeSeg, "backend-expert");
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: report, content: "{}" }, "backend-expert"));
      expect(denyReason(out!.stdout)).toContain("malformed JSON");
    }));

  test("write to an unrelated non-PRD file is not affected (case e)", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch";
      expect(await gate("codex", env, patchEvent(env, patch))).toBeNull();
    }));
});

describe("prevention: valid -> invalid router write is denied (case 7)", () => {
  test("codex patch turning a valid router schema-invalid", () =>
    withRouter(".codex", VALID, async (env) => {
      const out = await gate("codex", env, patchEvent(env, routerPatch(env, VALID, SCHEMA_BAD)));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("in_progress");
    }));

  test("claude Write turning a valid router syntax-invalid", () =>
    withRouter(".claude", VALID, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: router, content: SYNTAX_BAD }));
      expect(denyReason(out!.stdout)).toContain("malformed JSON");
    }));

  test("valid -> valid stays allowed (no regression)", () =>
    withRouter(".claude", VALID, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Edit", { file_path: router, old_string: "in-progress", new_string: "validated" }));
      expect(allowed(out)).toBe(true);
    }));

  test("underivable edit on a valid router keeps today's behaviour (not newly blocked)", () =>
    withRouter(".claude", VALID, async (env, router) => {
      const out = await gate("claude-code", env, claudeEvent(env, "Edit", { file_path: router, old_string: "nope", new_string: "x" }));
      expect(allowed(out)).toBe(true);
    }));
});

describe("after recovery: real done reports are still enforced (case 6)", () => {
  test("validate and Stop still refuse a task with no done report once the router is repaired", () =>
    withRouter(".claude", SCHEMA_BAD, async (env, router) => {
      const fixed = '{"auth-refactor":{"prd":"prd/auth-refactor-prd.json","status":"validated"}}';
      const out = await gate("claude-code", env, claudeEvent(env, "Write", { file_path: router, content: fixed }));
      expect(allowed(out)).toBe(true);
      writeFileSync(router, fixed); // the allowed write lands
      const r = await capture(() => runPrdValidate(["auth-refactor", "--root", env.root, "--id", "claude-code"], env.root, { FUSE_PRD: "1" }));
      expect(r.code).toBe(1); // backend-expert-2 has no done report
      const stop = prdStopGate({ session_id: env.sessionId }, env.root, "claude-code", env.trackFilePath, NOW);
      expect(JSON.parse(stop)).toMatchObject({ decision: "block" });
    }));
});

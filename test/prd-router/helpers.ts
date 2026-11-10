/**
 * Shared helpers for the PRD router recovery/diagnostics tests: a populated
 * PRD env whose router is overwritten with arbitrary text, plus builders for
 * the Claude Code (Write/Edit) and Codex (apply_patch) hook events.
 */
import { writeFileSync } from "node:fs";
import { prdPreGate } from "../../src/runtime/prd/prd-pre-gate";
import { normalizeEvent } from "../../src/runtime/normalize";
import type { NormalizedEvent } from "../../src/runtime/normalize";
import { prdAgentReportPath, prdRouterPath } from "../../src/policy/prd";
import { setupPrdEnv, type PrdTestEnv } from "../runtime/prd/env";
import { denyReason, isDenied } from "../runtime/prd/prd-pre-gate-helpers";

export { denyReason, isDenied, prdAgentReportPath };

export const NOW = 1_700_000_000_000;
export const VALID = '{"auth-refactor":{"prd":"prd/auth-refactor-prd.json","status":"in-progress"}}';
export const SCHEMA_BAD = '{"auth-refactor":{"prd":"prd/auth-refactor-prd.json","status":"in_progress"}}';
export const SYNTAX_BAD = '{"auth-refactor":{"prd":"prd/auth-refactor-prd.json","status":"in-progress"';

type Outcome = Awaited<ReturnType<typeof prdPreGate>>;

/** Runs `fn` against a PRD env (FUSE_PRD=1) whose router file holds `routerText`. */
export async function withRouter<T>(homeSeg: ".claude" | ".codex", routerText: string, fn: (env: PrdTestEnv, router: string) => Promise<T>): Promise<T> {
  const env = setupPrdEnv(homeSeg);
  try {
    process.env.FUSE_PRD = "1";
    const router = prdRouterPath(env.root, env.homeSeg);
    writeFileSync(router, routerText);
    return await fn(env, router);
  } finally {
    delete process.env.FUSE_PRD;
    env.restore();
  }
}

/** Codex apply_patch event (`agent` = non-coordinator agent_type). */
export function patchEvent(env: PrdTestEnv, patch: string, agent?: string): NormalizedEvent {
  return normalizeEvent("codex", {
    hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: env.sessionId, cwd: env.root,
    tool_input: { command: patch }, ...(agent ? { agent_id: "agent-x-0001", agent_type: agent } : {}),
  });
}

/** One-file Update patch replacing line `from` with `to` in the router. */
export function routerPatch(env: PrdTestEnv, from: string, to: string): string {
  return `*** Begin Patch\n*** Update File: ${env.homeSeg}/apex/prd.json\n@@\n-${from}\n+${to}\n*** End Patch`;
}

/** Claude Code Write/Edit event. */
export function claudeEvent(env: PrdTestEnv, tool: "Write" | "Edit", input: Record<string, unknown>, agent?: string): NormalizedEvent {
  return normalizeEvent("claude-code", {
    hook_event_name: "PreToolUse", tool_name: tool, session_id: env.sessionId, tool_input: input,
    ...(agent ? { agent_id: "agent-x-0001", agent_type: agent } : {}),
  });
}

/** Runs the real pre-gate for `id`. */
export function gate(id: "claude-code" | "codex", env: PrdTestEnv, event: NormalizedEvent): Promise<Outcome> {
  return prdPreGate(id, {}, event, env.root, env.trackFilePath, NOW);
}

/** True when the gate produced an explicit allow (non-null, not a deny). */
export function allowed(out: Outcome): boolean {
  return out !== null && !isDenied(out.stdout);
}

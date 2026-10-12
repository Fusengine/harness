import { sessionStartCore } from "./session-start";
import { injectRules } from "./inject-rules";
import { resolveRulesRoot } from "./rules-root";
import { solidDetectStart } from "./solid-detect";
import { subagentCacheContext } from "./subagent-cache";
import { trackAgentMemory } from "./agent-memory";
import { harvestSubagentTrack } from "../../freshness/evidence-harvest-io";
import { mergeCursorChildTrack } from "../../freshness/cursor-child-harvest";
import { markSubagentSeen } from "../confirm/confirm-subagent";
import { recordCursorSubagentLink } from "../confirm/cursor-subagent-link";
import { teammateIdleContext } from "./teammate-idle-check";
import { failureLessonContext } from "./failure-lesson";
import { postCompactContext } from "./post-compact";
import { saveApexState } from "./pre-compact";
import { cleanupSession } from "./session-end";
import { validateRulesLoaded } from "./instructions-loaded";
import { validateTaskSolid } from "./task-completed";
import { cartoSessionStart } from "./cartographer/session-start";
import { dispatchLessons } from "./lessons/dispatch";
import { withSnapshot } from "./snapshot";
import { stopCore } from "./stop-core";
import { prdSubagentContext, prdSubagentStopGate, prdStopGate } from "../prd";
import { joinContextResponses } from "../../policy/prd";
import { sanitizeSessionId } from "../home-state";
import { defaultStateDir, trackFile } from "../paths";
import { injectStateDir, removeSessionScopes } from "../inject-session/registry";

/** Which plugin's hooks.json invoked the harness (selects SessionStart behavior). */
export type PluginScope = "core" | "solid" | "rules" | "carto" | "security" | "changelog" | "aipilot" | "lessons" | "seo" | "memory" | "tailwindcss" | "motion";

/** Inputs the lifecycle dispatcher needs (clock + roots injected). */
export interface LifecycleInput {
  event: string;
  payload: Record<string, unknown>;
  cwd: string;
  scope: PluginScope;
  now: number;
  /** Harness target id (defaults to "claude-code" — zero-regression default). */
  id?: string;
}

/** SessionStart handler keyed on plugin scope. */
function sessionStart(input: LifecycleInput): string {
  if (input.scope === "solid") return solidDetectStart();
  if (input.scope === "rules") return injectRules(resolveRulesRoot(input.id ?? "claude-code", input.cwd), input.event, input.id ?? "claude-code");
  if (input.scope === "carto") return cartoSessionStart(input.cwd, input.now);
  if (input.scope === "lessons") return dispatchLessons("SessionStart", input.payload, input.cwd, input.now, input.id ?? "claude-code");
  const core = sessionStartCore(input.cwd, undefined, input.now, input.id ?? "claude-code");
  // core scope only: concatenate the reconciliation snapshot onto the existing
  // additionalContext (CLAUDE.md + dev-context) — never replaces it, fail-safe.
  return input.scope === "core" ? withSnapshot(core, input.cwd, import.meta.url) : core;
}

/**
 * Route a lifecycle/session/context hook event to its ported handler. Returns
 * the native stdout when handled, or `null` when the event is not a lifecycle
 * event (so the caller falls through to the PreToolUse/PostToolUse pipeline).
 * @param input - The dispatch input.
 * @returns The native hook stdout, or `null` when unhandled.
 */
export function dispatchLifecycle(input: LifecycleInput): string | null {
  switch (input.event) {
    case "SessionStart":
      return sessionStart(input);
    case "UserPromptSubmit":
      if (input.scope === "rules") return injectRules(resolveRulesRoot(input.id ?? "claude-code", input.cwd), input.event, input.id ?? "claude-code");
      if (input.scope === "lessons") return dispatchLessons("UserPromptSubmit", input.payload, input.cwd, input.now, input.id ?? "claude-code");
      return null;
    case "SubagentStart":
      // G0 (CONFIRM-token mechanism, confirm-subagent.ts): mark this session
      // as having recent sub-agent activity BEFORE the scope branching below,
      // so it fires regardless of which plugin scope dispatched it. A
      // monotone max-write timestamp, NOT a counter — see confirm-subagent.ts's
      // subagentWindowMs doc for why a start/stop counter desyncs unsafely
      // under this same multi-plugin fan-out.
      // Cursor sub-agents run under their own conversation_id: this event carries the PARENT (human)
      // chat's id, so G0 would freeze the human, not the sub-agent — Cursor guards the child conversation
      // itself instead (handle.ts). Remember the parent chat for CONFIRM inheritance.
      if (input.id === "cursor") recordCursorSubagentLink(input.payload);
      else markSubagentSeen(input.payload.session_id, input.now);
      if (input.scope === "rules") return injectRules(resolveRulesRoot(input.id ?? "claude-code", input.cwd), input.event, input.id ?? "claude-code");
      if (input.scope === "aipilot") return "";
      if (input.scope === "lessons") return dispatchLessons("SubagentStart", input.payload, input.cwd, input.now, input.id ?? "claude-code");
      return joinContextResponses(subagentCacheContext(input.payload.session_id), prdSubagentContext(input.payload, input.cwd, input.id ?? "claude-code"));
    case "Stop": {
      if (input.scope === "lessons") return dispatchLessons("Stop", input.payload, input.cwd, input.now, input.id ?? "claude-code");
      if (input.scope !== "core") return null;
      const prdBlock = prdStopGate(input.payload, input.cwd, input.id ?? "claude-code", trackFile(sanitizeSessionId(input.payload.session_id) ?? "unknown", defaultStateDir(input.cwd)), input.now);
      return prdBlock || stopCore(input.payload, input.cwd, input.now, input.id ?? "claude-code");
    }
    case "SubagentStop": {
      // G0 counterpart of the SubagentStart branch above — the SAME
      // monotone max-write, never a decrement (see confirm-subagent.ts). Not on Cursor (see above).
      if (input.id !== "cursor") markSubagentSeen(input.payload.session_id, input.now);
      if (input.scope === "aipilot") return "";
      // Retroactively harvest the finishing sub-agent's transcript into the session
      // track BEFORE the reminder — so next turn's freshness gate sees research/
      // explore evidence even when sidechain PostToolUse hooks never fired
      // (#43612/#27655/#34692). SubagentStop is main-session-dispatched (reliable).
      harvestSubagentTrack(input.payload, input.cwd, input.now);
      // Cursor sub-agents run under their own conversation_id: fold the child's evidence into the parent.
      if (input.id === "cursor") mergeCursorChildTrack(input.payload, input.cwd, input.now);
      // null = PRD had nothing to say (off, unnamed agent, or genuinely done)
      // -> normal trackAgentMemory handling; a non-null string (block, or ""
      // on an already-blocked replay) must be returned AS-IS, never layered
      // under a stale "agent completed" message.
      const prdBlock = prdSubagentStopGate(input.payload, input.cwd, input.id ?? "claude-code", trackFile(sanitizeSessionId(input.payload.session_id) ?? "unknown", defaultStateDir(input.cwd)), input.now);
      return prdBlock !== null ? prdBlock : trackAgentMemory(input.payload, undefined, input.now, input.id ?? "claude-code");
    }
    case "TeammateIdle":
      return teammateIdleContext(input.payload, input.cwd, undefined, input.now);
    case "PostToolUseFailure":
      return failureLessonContext(input.payload, input.cwd, undefined, input.now);
    case "PostCompact":
      return input.scope === "core" ? postCompactContext(input.payload, input.cwd, import.meta.url, input.now, input.id ?? "claude-code") : "";
    case "PreCompact":
      return saveApexState(input.cwd, input.now, input.id ?? "claude-code");
    case "SessionEnd": {
      if (input.scope !== "aipilot") cleanupSession(undefined, input.now);
      // Claude Code: drop this session's once-per-session registry (inject-session/); other hosts never create one.
      // Sanitized id: scopes are created under it, so a padded raw id would miss them.
      const sid = sanitizeSessionId(input.payload.session_id);
      if ((input.id ?? "claude-code") === "claude-code" && sid) removeSessionScopes(injectStateDir(input.cwd), sid);
      return "";
    }
    case "InstructionsLoaded":
      validateRulesLoaded(input.payload);
      return "";
    case "TaskCompleted":
      return validateTaskSolid(input.payload);
    default:
      return null;
  }
}

export { dispatchAipilot, aipilotPostToolUse } from "./aipilot/dispatch-aipilot";

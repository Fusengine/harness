/**
 * @module prd-subagent-context
 * SubagentStart injection (design doc §2.3) — the sub-agent's own PRD slice,
 * never the whole task. Kept SYNCHRONOUS on purpose: `dispatchLifecycle` is
 * called synchronously (no `await`) from `lifecycle-bridge.ts`/`handle.ts`,
 * and making that chain async for one new injector would touch 3 unrelated
 * files purely for signature plumbing — `prd-io.ts`'s sync twins
 * (`readRouterSync`/`readTaskFileSync`) exist precisely so this call site
 * needs zero signature changes anywhere else.
 */
import { contextResponse } from "../../adapters/claude";
import { harnessHomeSegment } from "../../policy/apex-target";
import {
  agentSlices, isPrdEnabled, prdProjectRoot, readRouterSync, readTaskFileSync, renderAgentSliceMarkdown,
  type PrdSubagentSlice,
} from "../../policy/prd";
import { respond } from "../respond";

/** Compliance reminder appended after the rendered slice(s) — the 3 rules a sub-agent must keep in mind. */
const RULES = [
  "1. Write ONLY the files listed in your slice above.",
  "2. Report completion to YOUR OWN agent-report file above — never another agent's.",
  "3. Do not mark a sub-task done until the work is actually finished; the coordinator validates from your report.",
].join("\n");

/** `agent_type`, same fallback `dispatch-aipilot.ts`'s `agentTypeOf` uses (duplicated here per SOLID file-size discipline, not cross-imported). */
function agentTypeOf(payload: Record<string, unknown>): string {
  return String(payload.agent_type ?? payload.subagent_type ?? "");
}

/**
 * Build the SubagentStart PRD context injection for this agent, or `""` when
 * the module is off, the caller is unnamed, or nothing in the router
 * concerns it.
 * @param payload - The raw SubagentStart hook payload.
 * @param cwd - Project root.
 * @param id - Harness target id.
 * @returns The native `additionalContext` hook stdout, or `""`.
 */
export function prdSubagentContext(payload: Record<string, unknown>, cwd: string, id: string): string {
  if (!isPrdEnabled(cwd, id)) return "";
  const agentType = agentTypeOf(payload);
  if (!agentType) return "";
  const root = prdProjectRoot(cwd);
  const homeSeg = harnessHomeSegment(id);
  const router = readRouterSync(root, homeSeg);
  if (!router) return "";

  const slices: PrdSubagentSlice[] = [];
  for (const [task, entry] of Object.entries(router)) {
    const taskFile = readTaskFileSync(root, homeSeg, entry.prd);
    if (!taskFile) continue;
    slices.push(...agentSlices(taskFile, agentType, task));
  }
  if (slices.length === 0) return "";

  const text = `${renderAgentSliceMarkdown(slices, { root, homeSeg })}\n\n### Rules\n${RULES}`;
  // gemini-cli/cline don't understand Claude's hookSpecificOutput.additionalContext
  // envelope: gemini-cli's native shape has no hookEventName field and cline's
  // is `{contextModification}` entirely — route them through respond()'s
  // already-correct "inform" branches. claude-code/codex/kimi/cursor/hermes
  // stay on contextResponse unchanged: respond()'s "inform" kind re-wraps the
  // text through formatPrompt (adds a "[NOTE] title" line), which would NOT
  // reproduce today's byte-identical raw-markdown output.
  if (id === "gemini-cli" || id === "cline") {
    return respond(id, { kind: "inform", title: "PRD assignment", reason: text }, "SubagentStart");
  }
  return contextResponse("SubagentStart", text);
}

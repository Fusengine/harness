import { extractText } from "../cache/mcp-response";
import { activityFor } from "./activity";
import { mcpPostStore } from "./mcp";
import { recordActivity } from "./record";
import { designGate } from "./design";
import { postEditContext } from "./lifecycle-bridge";
import { postTrackingSideEffects } from "./lifecycle/post-tracking";
import { aipilotPostToolUse, checkFileSize, validateTailwind } from "./lifecycle";
import { seoPostToolUseResponse } from "./lifecycle/seo/post-tool-use";
import { classifyAgentEvidence, recordAgentEvidence } from "../freshness/agent-evidence-record";
import { recordCodexSpawnEvidence } from "../freshness/codex-spawn-evidence";
import { captureBashReceipt } from "./receipt-capture";
import { recordCodexPostFailure } from "../tracking/codex-post-failure";
import { projectStateDir } from "./project-state-dir";
import { fanOutFiles, firstFileMatch } from "./post-fanout";
import { postOutcome } from "./post-outcome";
import { rawEventName } from "./handle-payload";
import { prdPostCheck } from "./prd";
import type { PreContext } from "./handle-pre";
import type { HandleOutcome } from "./handle";

function isCursorAfterFileEdit(id: string, payload: Record<string, unknown>): boolean {
  if (id !== "cursor") return false;
  const hookEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (hookEvent) return /^afterFileEdit$/i.test(hookEvent);
  return typeof payload.file_path === "string" && Array.isArray(payload.edits);
}

/**
 * Run the PostToolUse pipeline: store the MCP response, emit a design warning,
 * record the activity into the session track, apply per-scope side-effects (SEO
 * deny, aipilot task cache), then inject the post-edit context.
 *
 * POST is advisory-only for the design pipeline: it can never undo a tool
 * that already ran (the hard block lives in the PreToolUse `designFilesGate`).
 * `designGate` therefore stays on the RAW, un-fanned event — its
 * `recordPost` apply_patch branch is promote-only and resolves relative
 * `design-system.md` paths via `join(cwd, …)` (design-helpers.ts); fanning
 * that call would instead route the file through the Write/Edit branch,
 * which reads `event.filePath` UNRESOLVED (breaking cwd-relative promotion)
 * and can DEGRADE the state — both forbidden by the apply_patch promote-only
 * doctrine (see `design-files-gate.ts` module doc). Only `designPassNotice`
 * (pure formatting, no disk access, no state write) is fanned via
 * {@link fanOutFiles}, so `apply_patch` gets one notice line per real file
 * instead of none.
 * @param ctx - The resolved context (same shape as the pre pipeline).
 * @returns The native hook outcome.
 */
export async function handlePost(ctx: PreContext): Promise<HandleOutcome> {
  const { id, payload, event, framework, mcpDir, file, opts } = ctx;
  const cursorAfterFileEdit = isCursorAfterFileEdit(id, payload);
  const designCacheDir = ctx.designCacheDir ?? mcpDir;
  let response = payload.tool_response ?? payload.tool_output;
  if (id === "cursor" && /^afterMCPExecution$/i.test(event.eventName ?? "")) {
    try {
      response = typeof payload.result_json === "string" ? JSON.parse(payload.result_json) : payload.result_json;
    } catch {
      response = undefined;
    }
  }
  mcpPostStore(event.tool, event.input, response, mcpDir);
  const designWarn = designGate(payload, event, designCacheDir, opts.cwd, opts.corpusRoot);
  const activities = activityFor({ tool: event.tool, input: event.input, sessionId: event.sessionId, framework, now: opts.now, responseLength: extractText(response).length });
  for (const activity of activities) await recordActivity(file, activity);
  // Session-scoped evidence (parity track-subagent-research.py): sub-agent hooks
  // carry the LEAD's session_id — Task/Agent launches excluded (credited above).
  const evidence = classifyAgentEvidence(event.tool, event.input, response);
  if (evidence) await recordAgentEvidence(file, evidence, opts.now, typeof payload.agent_id === "string" ? payload.agent_id : undefined);
  // Codex multi_agent_v2 `spawn_agent` -> same session track (no-op for every
  // other harness / non-spawn tool / missing `agent_type`; see module doc).
  await recordCodexSpawnEvidence(file, id, event.tool, event.input, opts.now);
  // Verification receipts (static-check/test runs, see receipt-runners) —
  // structured responses only (Kimi's string `tool_output` would forge a
  // success receipt; see module).
  await captureBashReceipt(file, event.tool, event.command, payload.tool_result, response, opts.now, payload.duration_ms, id === "claude-code" && rawEventName(payload) === "PostToolUse" ? { toolInput: (payload.tool_input ?? {}) as Record<string, unknown> } : undefined);
  if (id === "codex") recordCodexPostFailure(event.tool, payload.tool_result ?? response, { now: opts.now, dir: projectStateDir(opts.cwd), sessionId: event.sessionId });
  // Codex `apply_patch` and Cursor `afterFileEdit` fan into per-file events for
  // tracking, validation, post-edit context, and notices.
  const files = fanOutFiles(event);
  for (const f of files) postTrackingSideEffects(opts.scope ?? "core", f, f.input, opts.now, payload, opts.cwd);
  await prdPostCheck(id, event, opts.cwd, file, opts.now); // PRD cross-check — advisory only, never returns stdout
  const seoDeny = opts.scope === "seo" ? seoPostToolUseResponse(payload) : null;
  if (seoDeny && !cursorAfterFileEdit) return { stdout: seoDeny, exit: 0 };
  if (opts.scope === "solid") {
    const solidWarn = firstFileMatch(files, checkFileSize);
    if (solidWarn && !cursorAfterFileEdit) return { stdout: solidWarn, exit: 0 };
  }
  if (opts.scope === "tailwindcss") {
    const tailwindWarn = firstFileMatch(files, validateTailwind);
    if (tailwindWarn && !cursorAfterFileEdit) return { stdout: tailwindWarn, exit: 0 };
  }
  if (opts.scope === "aipilot" && (event.tool === "TaskCreate" || event.tool === "TaskUpdate" || event.tool === "Write" || event.tool === "Edit")) {
    const out = await aipilotPostToolUse(payload, opts.cwd, id);
    if (out && !cursorAfterFileEdit) return { stdout: out, exit: 0 };
  }
  let extra = "";
  for (const f of files) {
    extra = await postEditContext(opts.scope ?? "core", f, opts.now, id);
    if (extra) break;
  }
  return postOutcome({
    id, agentId: typeof payload.agent_id === "string" ? payload.agent_id : "", sessionId: event.sessionId,
    now: opts.now, cwd: opts.cwd, activities, files,
    designCacheDir, designWarn, extra,
    cursorAfterFileEdit,
    cursorEventName: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "",
  });
}

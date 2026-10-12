import { join } from "node:path";
import { projectLayout } from "../config/layout";
import { detectFramework } from "../policy/detect-framework";
import { detectCreationIntent } from "../policy/creation-intent";
import { recordBrainstormRequired } from "../tracking/session-state";
import { withTrack } from "../tracking/store";
import { normalizeEvent } from "./normalize";
import { defaultStateDir, projectHash, trackFile } from "./paths";
import { fuseHarnessHome } from "./home-state";
import { designLifecycle } from "./design-lifecycle";
import { promptSubmitContext } from "./inject-context";
import { lifecycleStdout } from "./lifecycle-bridge";
import { handlePre } from "./handle-pre";
import { handlePost } from "./handle-post";
import { asyncScopeStdout } from "./handle-scope-async";
import { resolveDesignCacheDir } from "./design-cache-resolve";
import { resyncCodexAgents } from "./lifecycle/codex-resync/resync";
import { resetFragmentRegistry } from "./fragment-registry";
import { attachBudgetRecap } from "./inject-budget-recap";
import { applySessionRegistry } from "./inject-session/apply";
import { promptText } from "./prompt-text";
import { handleConfirmSubmit } from "./confirm/confirm-submit";
import { submitCodexConfirmation } from "./confirm/codex-confirm";
import { codexPromptOrigin } from "./confirm/codex-prompt-origin";
import { confirmFeedbackText, confirmPendingLines, mergeConfirmFeedback } from "./confirm/confirm-feedback";
import type { ConfirmSubmitOutcome } from "./confirm/confirm-outcome";
import { motionHook } from "./motion";
import { rawEventName, cursorRawPayloadProjection } from "./handle-payload";
import { cursorProjectCwd } from "../adapters/cursor/context";
import { toCursorLifecycleResponse } from "../adapters/cursor/respond";
import type { HandleOptions, HandleOutcome } from "./handle-types";
import type { NormalizedEvent } from "./normalize";
export type { HandleOptions, HandleOutcome } from "./handle-types";

/**
 * The full hook handler: on a PRE event it gates the tool-use (stateless guards
 * then APEX gates from the session track) and returns the native response; on a
 * POST event it records the activity into the track. The loop that makes the
 * package behave like the Claude plugin, on any harness.
 */
async function handleHookCore(id: string, payload: Record<string, unknown>, opts: HandleOptions): Promise<HandleOutcome> {
  const event = normalizeEvent(id, payload);
  if (id === "cursor") {
    const cursorCwd = cursorProjectCwd(event.cwd, event.workspaceRoots ?? [], event.filePath, opts.cwd);
    // Copy property DESCRIPTORS, not values: a spread would run bin.ts's lazy `refsDir` getter here, defeating its laziness.
    if (cursorCwd !== opts.cwd) opts = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(opts), cwd: { value: cursorCwd, enumerable: true, writable: true, configurable: true } }) as HandleOptions;
  }
  // Single passage point (see cursorRawPayloadProjection doc): every raw-payload
  // consumer below this line gets the canonical tool_name/cwd on Cursor; every
  // other harness id gets `payload` back untouched (byte-identical object).
  const hookPayload = cursorRawPayloadProjection(payload, event, opts.cwd, id);
  // `motion` scope: its own gates only; the core pipeline below (design/lifecycle/UPS/pre/post) would be duplicated.
  if (opts.scope === "motion") return motionHook(id, hookPayload, event, opts);
  const rawPrompt = payload.prompt;
  const userPrompt = typeof rawPrompt === "string" || Array.isArray(rawPrompt) ? promptText(rawPrompt) : undefined;
  // CONFIRM outcome of this UserPromptSubmit, if any — acked visibly at the
  // single UPS stdout return below (never for a prompt without a code).
  let confirmOutcome: ConfirmSubmitOutcome | null = null;
  if (id === "codex" && rawEventName(payload) === "UserPromptSubmit" && userPrompt !== undefined) {
    confirmOutcome = submitCodexConfirmation(event.sessionId, userPrompt, opts.now, opts.home, codexPromptOrigin(payload));
  }
  // Fresh slate for this invocation's capFragment tally — one hook event is
  // exactly one lifecycle branch below (see dispatchLifecycle), so a single
  // reset here can never mix fragments across unrelated events.
  resetFragmentRegistry();
  const layout = projectLayout(opts.cwd);
  const file = trackFile(event.sessionId, defaultStateDir(opts.cwd));
  const mcpDir = layout.cacheDir;
  // Design pipeline (flag + `.design-state-*.json`) is anchored on the session
  // id, not `mcpDir`/cwd — see design-cache-resolve.ts. `mcpDir` itself stays
  // cwd-derived for the unrelated MCP/WebFetch cache.
  const designCacheDir = resolveDesignCacheDir(event.sessionId, mcpDir, opts.home);
  const framework = detectFramework(event.filePath ?? "", event.content ?? "", opts.cwd);

  // Design-agent lifecycle (SubagentStart/Stop): init/cleanup the pipeline state machine.
  // claude-code + codex only: verified against openai/codex's OWN generated hook schemas
  // (codex-rs/hooks/schema/generated/subagent-{start,stop}.command.input.schema.json @ 385c0a93,
  // superseding the stale 44918ea1 Cargo.toml-only bump) — `agent_id`/`agent_type` are REQUIRED
  // on both events, unconditional on `hide_spawn_agent_metadata` (that flag only reshapes the
  // spawn_agent tool RESULT, not the hook payload). `payload.prompt` (design-mode "component"
  // detection below) is absent from Codex's schema — degrades to detectMode's default, not a
  // break. Cursor/Gemini/Cline/Hermes remain unverified — NOT added without the same proof.
  if ((id === "claude-code" || id === "codex") && designLifecycle(payload, designCacheDir, opts.cwd, String(opts.now), opts.now)) {
    return { stdout: "", exit: 0 };
  }

  // Codex-only, fail-open: refresh the plugin agents/commands cache on SessionStart when its fingerprint changed (strict no-op on every other harness).
  if (id === "codex" && rawEventName(payload) === "SessionStart") resyncCodexAgents();

  // Async per-scope lifecycle (aipilot cache handlers + memory-neural Graphiti).
  const asyncOut = await asyncScopeStdout(opts.scope, rawEventName(payload), hookPayload, opts.cwd, opts.now, id);
  if (asyncOut !== null) return { stdout: asyncOut, exit: 0 };

  // Ported lifecycle/session/context hooks (SessionStart, SubagentStart/Stop, etc.).
  const life = lifecycleStdout(hookPayload, opts.cwd, opts.scope ?? "core", opts.now, id);
  if (life !== null) {
    // Claude-Code-only: attachBudgetRecap's systemMessage envelope assumes the
    // Claude adapter's stdout shape (mirrors the designLifecycle gate above).
    const stdout = id === "claude-code" ? attachBudgetRecap(life, rawEventName(payload), event.sessionId, opts.cwd, opts.now) : life;
    return { stdout, exit: 0 };
  }

  // UserPromptSubmit (core scope): brainstorm flag + CLAUDE.md injection.
  // `payload.prompt` is a string on Claude Code/Codex, an array of content
  // blocks on Kimi (see promptText) — either shape is normalized to text;
  // anything else (field absent, or an unrecognized type) stays `undefined`
  // so the block below is skipped exactly as before promptText existed.
  if (userPrompt !== undefined) {
    // G0 on Cursor: a sub-agent's own conversation (it carries `parent_tool_call_id`) can never arm a CONFIRM.
    const cursorSubagentPrompt = id === "cursor" && payload.parent_tool_call_id !== undefined;
    if (id !== "codex" && !cursorSubagentPrompt) confirmOutcome = handleConfirmSubmit(event.sessionId, userPrompt, opts.now, opts.home);
    await withTrack(file, (track) => recordBrainstormRequired(track, detectCreationIntent(userPrompt)));
    // Visible CONFIRM ack (hosts with a verified UPS channel only); no code
    // typed → "" → mergeConfirmFeedback returns the context stdout unchanged.
    const feedback = confirmOutcome ? confirmFeedbackText(confirmOutcome, confirmPendingLines(id, event.sessionId, opts.now, opts.home)) : "";
    return { stdout: mergeConfirmFeedback(id, feedback, promptSubmitContext(userPrompt, opts.cwd, id)), exit: 0 };
  }

  if (event.phase === "post") {
    return handlePost({ id, payload: hookPayload, event, framework, mcpDir, designCacheDir, file, opts });
  }

  return handlePre({ id, payload: hookPayload, event, framework, mcpDir, designCacheDir, file, opts });
}

/**
 * Run one hook and adapt every Cursor scope outcome at the common runtime exit.
 * Other harnesses retain the core handler's stdout and exit status unchanged.
 * Cursor's shared `additional_context` budget context (see
 * `../adapters/cursor/context-budget.ts`) is assembled here too — this is
 * the single point every Cursor stdout passes through exactly once, so it's
 * also the single point that reserves from and records into the registry.
 * With no `session_id`/`conversation_id` at all, `sessionId` is `""` — the
 * registry key would degenerate to one bucket shared by every session-less
 * call on the same (cwd, event) pair, so `budget` stays `undefined` instead
 * (falls back to the flat per-response cap in `toCursorLifecycleResponse`,
 * with zero registry I/O). `stateDir` honors `opts.home` (test-only OS home
 * override, see `HandleOptions`) so tests never need the real `os.homedir()`.
 */
export async function handleHook(id: string, payload: Record<string, unknown>, opts: HandleOptions): Promise<HandleOutcome> {
  const outcome = await handleHookCore(id, payload, opts);
  // Claude Code only: every injected block reaches the model once per session (inject-session/); other hosts untouched.
  // `motion` is excluded: its UserPromptSubmit text answers THIS prompt (approval feedback), it is not a static block.
  if (id === "claude-code" && opts.scope !== "motion") return applySessionRegistry(outcome, payload, opts);
  if (id !== "cursor") return outcome;
  const eventName = rawEventName(payload);
  const cursorEvent = normalizeEvent(id, payload);
  const cwd = cursorProjectCwd(cursorEvent.cwd, cursorEvent.workspaceRoots ?? [], cursorEvent.filePath, opts.cwd);
  const sessionId = cursorEvent.sessionId;
  const generationId = typeof payload.generation_id === "string" && payload.generation_id ? payload.generation_id : undefined;
  const toolUseId = typeof payload.tool_use_id === "string" && payload.tool_use_id ? payload.tool_use_id : undefined;
  const stateDir = join(fuseHarnessHome(opts.home), "state", projectHash(cwd));
  const budget = sessionId ? { stateDir, sessionId, event: eventName, generationId, toolUseId } : undefined;
  return { ...outcome, stdout: toCursorLifecycleResponse(outcome.stdout, eventName, budget) };
}

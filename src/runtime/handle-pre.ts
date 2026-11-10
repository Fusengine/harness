import { dirname } from "node:path";
import { lazyRefs } from "../refs/lazy";
import { gate, gateCommandCandidates } from "./gate";
import { MCP_TTL_MS, mcpPreIntercept } from "./mcp";
import type { NormalizedEvent } from "./normalize";
import { recordActivity } from "./record";
import { respond } from "./respond";
import { withDenyNotice } from "./deny-notice";
import { designGate } from "./design";
import { taskContext } from "./inject-context";
import { securityAdvisory, securityAdvisoryForPatch } from "./lifecycle/security/check-skill";
import { solidScopeOutcome } from "./solid-pre";
import { isAgentTool } from "./is-agent-tool";
import { allowOutcome } from "./pre-allow";
import { applyPatchGate } from "./apply-patch-gate";
import { gatePatchFiles } from "./apply-patch-apex";
import { isBypassPermissions } from "../adapters/codex/permission-mode";
import { evaluate } from "../policy/evaluate";
import { confirmGate } from "./confirm/confirm-gate";
import { cursorParentSessionId } from "./confirm/cursor-subagent-link";
import { prdPreGate } from "./prd";
import { releasePrompt } from "./release-gate/pre";
import type { HandleOptions, HandleOutcome } from "./handle";

/** Context the PreToolUse pipeline needs (resolved once by {@link handleHook}). */
export interface PreContext {
  id: string;
  payload: Record<string, unknown>;
  event: NormalizedEvent;
  framework: string;
  mcpDir: string;
  /**
   * Session-anchored design-pipeline cache dir (see design-cache-resolve.ts) —
   * distinct from `mcpDir`. Optional: pre-existing context literals (tests
   * built before this field existed) omit it and fall back to `mcpDir`
   * unchanged, so they keep their old, already-passing behavior verbatim.
   */
  designCacheDir?: string;
  file: string;
  opts: HandleOptions;
}

/**
 * Run the PreToolUse pipeline: MCP/WebFetch cache intercept, design gate, APEX Task context injection, then the stateless+APEX gate chain, returning the native hook outcome (deny/ask/inject or allow).
 * @param ctx - The resolved pre-context.
 * @returns The hook outcome.
 */
export async function handlePre(ctx: PreContext): Promise<HandleOutcome> {
  const { id, payload, event, framework, mcpDir, file, opts } = ctx;
  const designCacheDir = ctx.designCacheDir ?? mcpDir;
  const intercept = mcpPreIntercept(id, event.tool, event.input, mcpDir, MCP_TTL_MS, opts.now);
  if (intercept !== null) {
    if (intercept.docSource) await recordActivity(file, { kind: "doc", framework, sessionId: event.sessionId, source: intercept.docSource });
    return { stdout: intercept.stdout, exit: 0 };
  }

  const designBlock = designGate(payload, event, designCacheDir, opts.cwd, opts.corpusRoot);
  if (designBlock) return { stdout: withDenyNotice(id, respond(id, designBlock, event.eventName ?? "PreToolUse"), designBlock, event.sessionId, dirname(file), opts.now), exit: 0 };

  if (id === "cursor" && (event.eventName === "beforeReadFile" || event.eventName === "beforeTabFileRead")) {
    const readPolicy = evaluate({ tool: event.tool, filePath: event.filePath });
    return {
      stdout: readPolicy.prompt
        ? respond(id, readPolicy.prompt, event.eventName)
        : JSON.stringify({ permission: "allow" }),
      exit: 0,
    };
  }

  // Security scope is advisory-only (ports check-security-skill.py): emit the
  // non-blocking advisory when the skill is unread, else allow — NEVER run the
  // core APEX/SOLID/file-size gate chain (the security plugin never did).
  if (opts.scope === "security") {
    return { stdout: event.files?.length ? securityAdvisoryForPatch(event.files, opts.now) : securityAdvisory(event.tool, event.filePath ?? "", opts.now), exit: 0 };
  }

  // Solid scope mirrors security above: run ONLY the solid-scope gates
  // (file-size deny, then Go/Python interface-location) and ALWAYS return —
  // NEVER the core gate chain: core-guards owns it, so falling through would
  // run gate() twice per edit (duplicate denies + added latency).
  if (opts.scope === "solid") {
    return solidScopeOutcome(id, event, file, opts.now);
  }

  // PreToolUse sub-agent dispatch (Task on claude/codex, Agent/AgentSwarm on
  // kimi): inject APEX sub-agent context when the target apex dir exists.
  if (isAgentTool(event.tool)) {
    const taskCtx = taskContext(opts.cwd, id);
    if (taskCtx) return { stdout: taskCtx, exit: 0 };
  }

  // PRD (task/agent ownership coordination): inert unless FUSE_PRD=1 AND a
  // router is present — see runtime/prd/prd-pre-gate.ts. Runs BEFORE the
  // apply_patch gate below: `applyPatchGate` runs `evaluate()` per file, whose
  // `runGuards()` already includes `protectedPathGuard` — which unconditionally
  // blocks every `.claude/apex/` path, PRD included. A PRD write this gate just
  // authorized must short-circuit past both `applyPatchGate` and the gate chain
  // further down, never reach either.
  const prdOutcome = await prdPreGate(id, payload, event, opts.cwd, file, opts.now);
  if (prdOutcome) return prdOutcome;

  // Codex `apply_patch`: normalize.ts fanned the freeform patch into per-file
  // changes. OR their static verdicts — one violating hunk blocks the whole
  // envelope. `event.files` is undefined for every other tool/harness.
  if (event.files && event.files.length > 0) {
    const patchPrompt = applyPatchGate(event.files, opts.cwd);
    if (patchPrompt) return { stdout: withDenyNotice(id, respond(id, patchPrompt, event.eventName ?? "PreToolUse"), patchPrompt, event.sessionId, dirname(file), opts.now), exit: 0 };
  }

  const gateInput = {
    sessionId: event.sessionId,
    framework,
    tool: event.tool,
    filePath: event.filePath,
    content: event.content,
    command: event.command,
    cwd: opts.cwd,
    loadRefs: await lazyRefs(opts.refsDir), // same throw point + error as the former eager load; real scan deferred to the consumer
    isReplaceAll: event.input.replace_all === true,
    oldString: event.oldString,
    agentType: event.agentType,
    agentId: typeof payload.agent_id === "string" ? payload.agent_id : undefined,
    windowMs: opts.windowMs,
    now: opts.now,
    trackFile: file,
    transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
    neverApproval: id === "codex" && isBypassPermissions(event.permissionMode),
  };
  // Codex `apply_patch` (identity-guarded: codex only) also runs the file-keyed
  // skill/APEX gates per patched file — before, its undefined `filePath` skipped them.
  const codexPatch = id === "codex" && event.tool === "apply_patch" && (event.files?.length ?? 0) > 0;
  const prompt = codexPatch
    ? await gatePatchFiles(gateInput, event.files!, event.toolUseId)
    : id === "cursor" && (event.commandCandidates?.length ?? 0) > 1
      ? await gateCommandCandidates(gateInput, event.commandCandidates!)
      : await gate(gateInput);
  const finalGate = prompt ?? releasePrompt(event, opts);
  if (finalGate) {
    // CONFIRM <code> flow: ONLY changes anything when Codex/Kimi/Cursor are
    // about to downgrade THIS `ask` to a hard deny (confirmGate returns null
    // in every other case — including every claude-code call, unconditionally,
    // and every non-`ask` prompt kind — so the line below is byte-identical to
    // the pre-CONFIRM behavior whenever it applies). A multi-candidate Cursor
    // MCP call is never confirmable: the decisive candidate may differ from
    // `event.command` (candidate 0), so hashing/G4-checking the latter would
    // let a token for a benign head unlock e.g. an `rm -rf` in tool_input.
    const multiCandidate = (event.commandCandidates?.length ?? 0) > 1;
    const confirm = confirmGate(id, finalGate, multiCandidate ? undefined : event.command, event.sessionId, opts.now, opts.home,
      id === "codex" ? { tool: event.tool, cwd: event.cwd ?? opts.cwd, toolUseId: event.toolUseId } : undefined,
      id === "cursor" && typeof payload.generation_id === "string" && payload.generation_id ? payload.generation_id : undefined,
      id === "cursor" ? cursorParentSessionId(payload, opts.home) : undefined);
    if (confirm?.allow) {
      return allowOutcome(id, event, payload, designCacheDir, opts.cwd, { trackFile: file, windowMs: opts.windowMs, now: opts.now }, opts.corpusRoot);
    }
    const finalPrompt = confirm ? confirm.prompt : finalGate;
    return { stdout: withDenyNotice(id, respond(id, finalPrompt, event.eventName ?? "PreToolUse"), finalPrompt, event.sessionId, dirname(file), opts.now), exit: 0 };
  }
  // Every gate allowed: hand off to the ALLOW-path assembly (pass notice +
  // decision-time lesson + evidence-fresh notice). A deny/ask already returned
  // above, so nothing it emits can block nor override a decision.
  return allowOutcome(id, event, payload, designCacheDir, opts.cwd, { trackFile: file, windowMs: opts.windowMs, now: opts.now }, opts.corpusRoot);
}

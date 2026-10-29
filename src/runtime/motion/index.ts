import { homedir } from "node:os";
import type { HandleOptions, HandleOutcome } from "../handle-types";
import type { NormalizedEvent } from "../normalize";
import { motionCall, stopReleasesRenders } from "./host";
import { motionSubagent, motionSessionStop } from "./lifecycle";
import { motionPost } from "./post";
import { motionPre } from "./pre";
import { motionPrompt } from "./prompt";
import { commandMotionProject } from "../../policy/motion/project-command";
import { respond } from "../respond";
import { protectedMotionCommand, protectedMotionDirectory } from "../../policy/motion/guard-scope";
import { motionKeyViolation } from "../../policy/motion/guard-key";
import { selfApprovalViolation } from "../../policy/motion/self-approval";
import { clearSessionCritics } from "../../policy/motion/critic-flag";
import { observeMotionProject, readMotionState, refreshMotionState, sessionMotionStates, updateMotionDeclarations, verifyMotionState } from "../../policy/motion/state";
import { appendMotionContext, motionStateResponse } from "./reply";
import type { MotionCall, MotionProject } from "../../policy/interfaces/motion";
import { LOCK_FAILED, withTrackLockSyncBlocking } from "../../tracking/track-lock-sync";
import { motionHome } from "../../policy/motion/store";
import { join, resolve } from "node:path";
import { approvalGate } from "../../policy/motion/gates";
import { classifyMotionCommand, shellMotionWriteTargets } from "../../policy/motion/command";
import { commandContexts } from "../../policy/motion/command-context";
import { canonicalFilePath } from "../prd/prd-canon";
import { findReservation, loadBudget, releaseRender } from "../../policy/motion/budget";
import { existsSync } from "node:fs";

/** Dispatch on the host-native event, reduced to its meaning for motion. */
function motionStdout(id: string, payload: Record<string, unknown>, event: NormalizedEvent, opts: HandleOptions, call: MotionCall, project: MotionProject | null): string {
  switch (call.kind) {
    case "subagentStart":
    case "subagentStop":
      motionSubagent(call.kind === "subagentStart" ? "SubagentStart" : "SubagentStop", payload, event.sessionId, opts.home ?? homedir());
      if (call.kind === "subagentStop" && event.agentId && stopReleasesRenders(id)) motionSessionStop(event.sessionId, event.agentId, opts.home ?? homedir(), opts.now);
      return "";
    case "prompt":
      return motionPrompt(id, payload, call, event.sessionId, opts);
    case "pre":
      return motionPre(id, call, opts, project);
    case "post":
    case "failure":
      return motionPost(id, call, opts);
    case "stop":
      clearSessionCritics(event.sessionId, opts.home ?? homedir());
      // The main turn's Stop releases NOTHING on any host: a sub-agent's
      // PreToolUse may carry no agent_id, so its reservations cannot be told
      // apart from the main turn's — a leak falls by the TTL (see
      // `stopReleasesRenders`).
      return "";
    default:
      return "";
  }
}

/**
 * Entry point of the `motion` scope: approval gates for the fuse-motion plugin.
 * Protected motion pre-tool decisions fail closed; unrelated events fail open.
 * @param id - Harness id.
 * @param payload - Raw hook payload.
 * @param event - Normalized event.
 * @param opts - Handler options (cwd, now, home).
 */
function lockedMotionHook(id: string, payload: Record<string, unknown>, event: NormalizedEvent, opts: HandleOptions): HandleOutcome {
  let protectedPre = false;
  let respondAs = "PreToolUse";
  let kind: MotionCall["kind"] = "none";
  let activeProject: MotionProject | null = null;
  let dispatchedPre = false;
  let preHadReceipt = false;
  let activeCall: MotionCall | undefined;
  try {
    let call = motionCall(id, payload, event);
    kind = call.kind;
    respondAs = call.respondAs;
    protectedPre = call.kind === "pre" && protectedMotionDirectory(opts.cwd, opts.home ?? homedir());
    if (call.kind === "pre" && /video-motion|\.motion/.test([call.event.filePath, call.event.command].join(" "))) protectedPre = true;
    const home = opts.home ?? homedir();
    const states = sessionMotionStates(event.sessionId, home);
    const project = commandMotionProject(call.event.command, opts.cwd, home);
    call = motionCall(id, payload, event, project?.root);
    activeCall = call;
    activeProject = project;
    protectedPre ||= call.kind === "pre" && project !== null;
    let coldNotice = "";
    if (project && !states.some((state) => state.project.root === project.root)) {
      const first = readMotionState(project.root, home) === null;
      const state = observeMotionProject(project, event.sessionId, home);
      states.push(state);
      if (first && state.coldArtifacts?.length) coldNotice = "Motion existing cold draft/master outputs are preserved but not approved; approve stills and complete an authorized draft render before G2.";
    }
    const terminal = kind === "post" || kind === "failure";
    const terminalMatches = terminal && call.event.toolUseId ? states.filter((state) => findReservation(loadBudget(state.project.root, home), call.event.toolUseId!)) : [];
    const settlementId = terminalMatches.length > 1 ? undefined : call.event.toolUseId;
    const terminalReceipt = terminalMatches.length === 1 && settlementId ? terminalMatches[0]!.renders[settlementId] : undefined;
    const messages = states.flatMap((state) => verifyMotionState(state, event.sessionId, settlementId, terminal, home, call.event.tool === "Read", kind !== "failure"));
    if (terminalMatches.length > 1) messages.push("Motion terminal identity is ambiguous across projects; no reservation or output receipt was accepted. Owner recovery required.");
    if (project) {
      const state = states.find((entry) => entry.project.root === project.root);
      if (state && (state.project.draft !== project.draft || project.masters.some((path) => !state.project.masters.includes(path)))) {
        updateMotionDeclarations(state, project, home);
        messages.push(...verifyMotionState(state, event.sessionId, call.event.toolUseId, false, home));
      }
    }
    let terminalStdout: string | undefined;
    if (kind === "post" || kind === "failure") {
      const terminalProject = terminalMatches.length === 1 ? terminalMatches[0]!.project : null;
      const start = terminalProject && call.event.toolUseId ? findReservation(loadBudget(terminalProject.root, home), call.event.toolUseId) : undefined;
      const targets = new Set<string>();
      if (terminalProject && terminalReceipt) for (const directory of new Set([opts.cwd, terminalProject.root])) {
        for (const [segment, cwd] of commandContexts(terminalReceipt.command, directory, home)) {
          for (const path of shellMotionWriteTargets(segment)) targets.add(canonicalFilePath(resolve(cwd, path)));
        }
      }
      const explicitMasters = terminalProject?.masters.filter((path) => targets.has(canonicalFilePath(path))) ?? [];
      // An opaque declared renderer owes all declared master outputs; an explicit writer owes its own targets.
      const ownOutputs = !terminalProject || !start ? [] : start.stage === "stills" ? [terminalProject.contact] : start.stage === "draft" ? terminalProject.draft ? [terminalProject.draft] : [] : explicitMasters.length ? explicitMasters : terminalProject.masters;
      const retained = ownOutputs.length > 0 && ownOutputs.every((path) => existsSync(path)) && !states.find((state) => state.project.root === terminalProject?.root)?.invalid;
      try { terminalStdout = motionPost(id, retained ? call : { ...call, kind: "failure" }, opts, terminalProject); }
      catch (error) {
        terminalStdout = "";
        messages.push(`Motion terminal budget settlement failed: ${error instanceof Error ? error.message : String(error)}. Owner recovery required.`);
      }
    }
    if (messages.length && kind !== "prompt") {
      for (const state of sessionMotionStates(event.sessionId, home)) refreshMotionState(state, home);
      return { stdout: kind === "pre" ? respond(id, { kind: "block", title: "Motion state verification", reason: messages.join("\n") }, respondAs) : motionStateResponse(id, respondAs, messages.join("\n")), exit: 0 };
    }
    preHadReceipt = kind === "pre" && !!(project && call.event.toolUseId && readMotionState(project.root, home)?.renders[call.event.toolUseId]);
    dispatchedPre = kind === "pre";
    const stdout = terminalStdout ?? motionStdout(id, payload, event, opts, call, project);
    // Pre may add a receipt in a separate state object; reload before updating protected metadata.
    for (const state of sessionMotionStates(event.sessionId, home)) refreshMotionState(state, home);
    return { stdout: appendMotionContext(id, respondAs, stdout, [coldNotice, ...(kind === "prompt" ? messages : [])].filter(Boolean).join("\n")), exit: 0 };
  } catch (err) {
    if (kind === "pre" && dispatchedPre && !preHadReceipt && activeProject && activeCall?.event.toolUseId) {
      try {
        const home = opts.home ?? homedir(), state = readMotionState(activeProject.root, home);
        if (state?.renders[activeCall.event.toolUseId]) {
          delete state.renders[activeCall.event.toolUseId];
          releaseRender(activeProject.root, activeCall.event.toolUseId, home);
          refreshMotionState(state, home);
        }
      } catch (error) { process.stderr.write(`harness motion reservation rollback: ${String(error)}\n`); }
    }
    if (kind === "pre" && !protectedPre) {
      try {
        const call = motionCall(id, payload, event), home = opts.home ?? homedir();
        protectedPre = protectedMotionCommand(call.event.command, opts.cwd, home)
          || motionKeyViolation(call.event, opts.cwd, home) !== null
          || selfApprovalViolation(call.event.tool, call.event.filePath, call.event.command, opts.cwd, home) !== null;
      } catch { protectedPre = true; }
    }
    process.stderr.write(`harness motion: ${err instanceof Error ? err.message : String(err)}\n`);
    if (kind === "pre" && activeProject && (err as NodeJS.ErrnoException).code) {
      const gate = approvalGate(classifyMotionCommand(event.command ?? "", opts.cwd, activeProject, opts.home ?? homedir()), activeProject, event.sessionId, opts.now, opts.home ?? homedir());
      try { for (const state of sessionMotionStates(event.sessionId, opts.home ?? homedir())) refreshMotionState(state, opts.home ?? homedir()); } catch { /* retain fail-closed response */ }
      if (gate) return { stdout: respond(id, gate, respondAs), exit: 0 };
    }
    const reason = "The protected motion operation could not be verified safely; retry after resolving the internal error.";
    const stdout = protectedPre ? respond(id, { kind: "block", title: "Motion protected decision failed", reason }, respondAs) : kind === "post" || kind === "failure" || kind === "stop" || kind === "subagentStop" ? motionStateResponse(id, respondAs, reason) : "";
    return { stdout, exit: 0 };
  }
}

/** Serialize registry, witness and receipt transitions independently of the approval/budget lock. */
export async function motionHook(id: string, payload: Record<string, unknown>, event: NormalizedEvent, opts: HandleOptions): Promise<HandleOutcome> {
  try {
    const result = withTrackLockSyncBlocking(join(motionHome(opts.home ?? homedir()), "state"), () => lockedMotionHook(id, payload, event, opts));
    if (result !== LOCK_FAILED) return result;
  } catch (error) {
    // The ordinary guarded path retains native approval denials when the store itself is unwritable.
    return lockedMotionHook(id, payload, event, opts);
  }
  const call = motionCall(id, payload, event);
  const text = "Motion state lock busy; protected operation cannot be verified safely.";
  return { stdout: call.kind === "pre" ? respond(id, { kind: "block", title: "Motion state verification", reason: text }, call.respondAs) : motionStateResponse(id, call.respondAs, text), exit: 0 };
}

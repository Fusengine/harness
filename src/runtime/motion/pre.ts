import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Prompt } from "../../prompt/types";
import type { MotionCall, MotionProject } from "../../policy/interfaces/motion";
import { activeCritics, isCriticAgentType } from "../../policy/motion/critic-flag";
import { criticViolation } from "../../policy/motion/critic";
import { selfApprovalViolation } from "../../policy/motion/self-approval";
import { approvalGate } from "../../policy/motion/gates";
import { budgetLine, loadBudget, openRender, pruneInflight, releaseRender } from "../../policy/motion/budget";
import { budgetStage, classifyMotionCommand } from "../../policy/motion/command";
import { approvalForgeryViolation } from "../../policy/motion/forgery";
import { commandMotionProject } from "../../policy/motion/project-command";
import { commandContexts } from "../../policy/motion/command-context";
import { projectContractViolation } from "../../policy/motion/project-guard";
import { findSensitive, loadBannedTerms } from "../../policy/motion/sensitive";
import { respond } from "../respond";
import type { HandleOptions } from "../handle-types";
import type { NormalizedEvent } from "../normalize";
import { canonicalFilePath } from "../prd/prd-canon";
import { bashSensitive, isUnder, patchSelfApproval, patchSensitive } from "./files";
import { replacementText } from "./diff-text";
import { MOTION_WRITE_TOOLS } from "../../policy/motion/constants";
import { motionKeyViolation } from "../../policy/motion/guard-key";
import { artifactMutationViolation } from "../../policy/motion/guard-artifact";
import { observeMotionProject, refreshMotionState } from "../../policy/motion/state";
import { detachedProcessViolation } from "../../policy/motion/guard-detach";


/** All text a write tool would put on disk (content, new_string, multi-edit strings). */
function writtenText(event: NormalizedEvent): string {
  const parts: string[] = [];
  const input = event.input;
  if (event.content && event.content !== input.content && event.content !== input.new_string) parts.push(event.content);
  if (typeof input.content === "string") parts.push(input.content);
  if (typeof input.new_string === "string") parts.push(input.new_string);
  if (typeof input.new_source === "string") parts.push(input.new_source);
  if (typeof input.diff === "string") {
    parts.push(replacementText(input.diff));
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const ns = (e as { new_string?: unknown } | null)?.new_string;
      if (typeof ns === "string") parts.push(ns);
    }
  }
  return parts.join("\n");
}

/** Does this tool call belong to a sandboxed critic? */
function fromCritic(event: NormalizedEvent, critics: string[]): boolean {
  if (isCriticAgentType(event.agentType ?? "")) return true;
  if (critics.length === 0) return false;
  if (!event.agentId) return true;
  return critics.includes(event.agentId);
}

/** Block prompt for a sensitive term found in a source write. */
function sensitiveBlock(hit: string): Prompt {
  return {
    kind: "block",
    title: "Sensitive data in motion source",
    reason: `The write failed the sensitive-data check (${hit}). Remove sensitive data before saving.`,
    actions: ["Remove the sensitive value from the content"],
  };
}

/**
 * PreToolUse gates of the motion scope: self-approval, critic sandbox, source
 * secret scan, then the stills->draft->master approval gate with render budget.
 * @param id - Harness id.
 * @param call - Host call reduced to the Claude-shaped view (canonical tool, event name for `respond()`).
 * @param opts - Handler options.
 * @returns The stdout ("" = allow).
 */
export function motionPre(id: string, call: MotionCall, opts: HandleOptions, resolvedProject?: MotionProject | null): string {
  const home = opts.home ?? homedir();
  const { event, respondAs } = call;
  const { tool, command } = event;
  const cwd = opts.cwd;
  const filePath = tool === "NotebookEdit" && typeof event.input.notebook_path === "string" ? event.input.notebook_path : event.filePath;
  const key = motionKeyViolation(event, opts.cwd, home);
  if (key) return respond(id, key, respondAs);
  const self = selfApprovalViolation(tool, filePath, command, cwd, home) ?? patchSelfApproval(event, cwd, home);
  if (self) return respond(id, self, respondAs);
  const forged = approvalForgeryViolation(tool, command, event.input);
  if (forged) return respond(id, forged, respondAs);
  if (command && tool === "Bash") {
    for (const [segment, directory] of commandContexts(command, cwd, home)) {
      const violation = selfApprovalViolation(tool, undefined, segment, directory, home)
        ?? projectContractViolation({ ...event, command: segment }, directory, home);
      if (violation) return respond(id, violation, respondAs);
    }
  } else {
    const contract = projectContractViolation(event, cwd, home);
    if (contract) return respond(id, contract, respondAs);
  }
  const project = resolvedProject === undefined ? commandMotionProject(command, opts.cwd, home) : resolvedProject;
  if (fromCritic(event, activeCritics(event.sessionId, home))) {
    const reviewDir = project?.reviewDir ?? join(opts.cwd, ".motion", "review");
    const sandbox = criticViolation(tool, filePath, command, reviewDir, opts.cwd);
    if (sandbox) return respond(id, sandbox, respondAs);
  }
  if (!project) return "";
  const detached = tool === "Bash" && command ? detachedProcessViolation(command) : null;
  if (detached) return respond(id, detached, respondAs);
  const banned = loadBannedTerms(home);
  if (MOTION_WRITE_TOOLS.has(tool) && filePath) {
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(opts.cwd, filePath);
    if (isUnder(canonicalFilePath(abs), canonicalFilePath(project.sourceDir))) {
      const hit = findSensitive(writtenText(event), banned);
      if (hit) return respond(id, sensitiveBlock(hit), respondAs);
    }
  }
  const patchHit = patchSensitive(event, project, opts.cwd, banned);
  if (patchHit) return respond(id, sensitiveBlock(patchHit), respondAs);
  if (tool !== "Bash" || !command) {
    const master = MOTION_WRITE_TOOLS.has(tool) && [filePath, ...(event.files ?? []).map((f) => f.filePath)].some((path) => path && project.masters.some((m) => canonicalFilePath(m) === canonicalFilePath(resolve(cwd, path))));
    const gate = master ? approvalGate({ ffmpegMaster: true }, project, event.sessionId, opts.now, home) : null;
    return gate ? respond(id, gate, respondAs) : "";
  }
  const fullHit = bashSensitive(command, project, cwd, banned);
  if (fullHit) return respond(id, sensitiveBlock(fullHit), respondAs);
  for (const [segment, directory] of commandContexts(command, cwd, home)) {
    const artifact = artifactMutationViolation(segment, project, directory, home);
    if (artifact) return respond(id, artifact, respondAs);
    const shellHit = bashSensitive(segment, project, directory, banned);
    if (shellHit) return respond(id, sensitiveBlock(shellHit), respondAs);
  }
  const cmd = classifyMotionCommand(command, cwd, project, home);
  const gate = approvalGate(cmd, project, event.sessionId, opts.now, home);
  if (gate) return respond(id, gate, respondAs);
  const stage = budgetStage(cmd);
  if (!stage) return "";
  const state = observeMotionProject(project, event.sessionId, home);
  // Expire leaked reservations: TTL-stale budget entries move to the retained
  // expired map; drop only receipts whose reservation is entirely gone. A fresh
  // reservation still blocks; an expired one admits the concurrent render but
  // keeps its receipt, so a late completion keeps its output attribution.
  const live = pruneInflight(project.root, opts.now, home);
  const retained = loadBudget(project.root, home).expired ?? {};
  let pruned = false;
  for (const id of Object.keys(state.renders)) {
    if (Object.hasOwn(live, id) || Object.hasOwn(retained, id)) continue;
    delete state.renders[id];
    pruned = true;
  }
  if (pruned) refreshMotionState(state, home);
  if (Object.entries(state.renders).some(([id, entry]) => entry.stage === stage && Object.hasOwn(live, id))) {
    return respond(id, { kind: "block", title: "Motion concurrent render", reason: "A render of this protected stage is still active (includes in-flight reservations); concurrent writers to the same outputs cannot be safely attributed." }, respondAs);
  }
  // A `noid:` id derives from session + command, so an EXPIRED reservation with
  // this exact id means the same command may still be running: refuse its
  // re-admission until the late completion settles it or the forget horizon
  // drops it (an id never lives in inflight AND expired). The hosts concerned
  // get no Stop release, so the 24 h horizon is the only other way out.
  if (event.toolUseId?.startsWith("noid:") && (Object.hasOwn(retained, event.toolUseId) || Object.entries(state.renders).some(([id, entry]) => entry.session === event.sessionId && Object.hasOwn(live, id)))) {
    return respond(id, { kind: "block", title: "Motion render identity", reason: "A host without native tool-call ids permits only one active render in this session; finish or cancel that call first." }, respondAs);
  }
  const reservation = openRender(project.root, event.toolUseId, stage, opts.now, home, process.env, event.sessionId, event.agentId);
  if (reservation) return respond(id, reservation, respondAs);
  if (event.toolUseId) state.renders[event.toolUseId] = { session: event.sessionId, stage, command };
  try { refreshMotionState(state, home); }
  catch (error) {
    if (event.toolUseId) delete state.renders[event.toolUseId];
    releaseRender(project.root, event.toolUseId, home);
    refreshMotionState(state, home);
    throw error;
  }
  const info: Prompt = { kind: "inform", title: "Motion render", reason: budgetLine(loadBudget(project.root, home)) };
  return respond(id, info, respondAs);
}

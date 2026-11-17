/**
 * @module prd-subagent-stop
 * Block-once gate for a finishing sub-agent with incomplete PRD sub-tasks
 * (design doc §2.4). SYNC on purpose — the SubagentStop dispatch runs
 * synchronously in a short-lived hook process; an async write could be
 * dropped before exit (same reasoning as `track-lock-sync.ts`).
 */
import { dirname } from "node:path";
import { harnessHomeSegment } from "../../policy/apex-target";
import {
  candidateAgentNames, incompleteSubTasks, isPrdEnabled, prdProjectRoot,
  readAgentReportSync, readRouterSync, readTaskFileSync, type PrdTaskFile,
} from "../../policy/prd";
import { journalLogPath, readTrackSync } from "../../tracking/track-compact";
import { trackJournalEnabled } from "../../tracking/store";
import { appendEvent } from "../../tracking/track-journal";
import { diffTrackEvents } from "../../tracking/track-diff";
import { prdAlreadyBlocked, recordPrdStopBlocked, type SessionTrack } from "../../tracking/session-state";
import { signTrack, writeLastNonce } from "../../tracking/integrity";
import { LOCK_FAILED, withTrackLockSyncBlocking } from "../../tracking/track-lock-sync";
import { spillTrackDiff } from "../../tracking/track-legacy-spill";
import { atomicWrite } from "../../util/json-io";
import { blockResponse } from "../../adapters/claude";
import { respond } from "../respond";

/** `agent_type`, same fallback duplicated across the PRD runtime modules (SOLID file-size discipline). */
function agentTypeOf(payload: Record<string, unknown>): string {
  return String(payload.agent_type ?? payload.subagent_type ?? "");
}

/** Renders the block reason for one finishing agent's incomplete sub-tasks. */
function reasonFor(agent: string, task: string, subs: string[]): string {
  return `PRD sub-task(s) not done for ${agent} on task "${task}": ${subs.join(", ")}. Finish the work (or ask the coordinator to reassign) before stopping.`;
}

/**
 * One-shot key for this finishing instance. Keyed by `agentId` when known —
 * the STABLE identity of "this specific sub-agent call", regardless of which
 * same-`agentType` candidate name it happens to match — so an unbound agent
 * (no prior Write) whose incompleteness is first found under one sibling
 * name doesn't get blocked a SECOND time on replay under the other sibling
 * name (both unbound candidates are checked every call; only the key must
 * stay identical). Falls back to per-name keying when `agentId` is absent
 * (Kimi-shaped payloads structurally never carry it).
 */
function stopKey(sessionId: string, agentId: string | undefined, agent: string): string {
  return agentId !== undefined ? `${sessionId}:SubagentStop:agent:${agentId}` : `${sessionId}:SubagentStop:${agent}`;
}

/**
 * Narrows the agentType-matching candidates to the ONE this specific
 * `agent_id` is already bound to (per `prdOwners`), when known — otherwise
 * every same-`agentType` sibling would be checked (and could block THIS
 * instance for a SIBLING's incomplete work, e.g. `backend-expert` vs
 * `backend-expert-2` sharing the same reported `agent_type`). Unbound (the
 * agent hasn't written anything yet) falls back to checking every candidate,
 * the only defensible default with no binding to disambiguate on.
 */
function resolveCandidates(agentType: string, taskFile: PrdTaskFile, agentId: string | undefined, bindings: Record<string, string>): string[] {
  const all = candidateAgentNames(agentType, taskFile);
  const bound = agentId !== undefined ? bindings[agentId] : undefined;
  return bound !== undefined && all.includes(bound) ? [bound] : all;
}

/**
 * Persist the one-shot block marker on the SAME side `trackJournalEnabled()`
 * reads from — mirrors `harvestSubagentTrack`'s branching (`evidence-harvest-
 * io.ts`), the codebase's only other sync lifecycle writer with this exact
 * constraint. Bug this fixes: the old code always appended to the journal
 * regardless of mode, but `readTrackSync(file, trackJournalEnabled())` never
 * folds the log when `FUSE_TRACK_JOURNAL=0` (track-compact.ts) — so a legacy
 * replay never saw the marker and re-blocked on every call. Journal mode
 * (default): unchanged, append the diff. Legacy mode: locked read-modify-
 * write straight into the snapshot (`signTrack` + atomic write + nonce, same
 * body as `store.ts#saveTrack`'s legacy branch), so the very next
 * `readTrackSync(file, false)` sees it.
 */
function persistStopBlocked(trackFilePath: string, track: SessionTrack, key: string, now: number): void {
  if (trackJournalEnabled()) {
    const next = recordPrdStopBlocked(track, key, now);
    for (const ev of diffTrackEvents(track, next, now)) appendEvent(journalLogPath(trackFilePath), ev.field, ev.op, ev.value, ev.ts);
    return;
  }
  const ran = withTrackLockSyncBlocking(dirname(trackFilePath), () => {
    const fresh = readTrackSync(trackFilePath, false); // reload under lock: avoid clobbering a concurrent legacy RMW
    const envelope = signTrack(recordPrdStopBlocked(fresh, key, now));
    atomicWrite(trackFilePath, JSON.stringify(envelope, null, 2));
    writeLastNonce(envelope.nonce);
  });
  if (ran === LOCK_FAILED) spillTrackDiff(trackFilePath, track, recordPrdStopBlocked(track, key, now), now); // shared budget spent: spill, never drop
}

/**
 * Run the PRD SubagentStop block-once gate.
 * @param payload - The raw SubagentStop hook payload.
 * @param cwd - Project root.
 * @param id - Harness target id.
 * @param trackFilePath - The session track file path.
 * @param now - Event clock.
 * @returns `null` when PRD had nothing to say (module off, unnamed agent, or
 * every assigned sub-task is genuinely done) — the caller falls through to
 * its normal SubagentStop handling (e.g. `trackAgentMemory`). A non-null
 * string means PRD DID find an incomplete sub-task for this agent: the
 * block stdout the first time, or `""` on every later replay of the SAME
 * incompleteness (already-blocked-once) — either way the caller must return
 * it AS-IS and skip its normal handling (a stale "agent completed" message
 * would contradict the block that was just — or already — issued).
 */
export function prdSubagentStopGate(payload: Record<string, unknown>, cwd: string, id: string, trackFilePath: string, now: number): string | null {
  if (!isPrdEnabled(cwd, id)) return null;
  // Cursor's sub-agent identity is structurally unlinkable at this event
  // (design doc Risks §1) and Cursor never honors a block on SubagentStop
  // anyway (adapters.md) — never even build a block payload for it.
  if (id === "cursor") return null;
  const agentType = agentTypeOf(payload);
  if (!agentType) return null;
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const root = prdProjectRoot(cwd);
  const homeSeg = harnessHomeSegment(id);
  const router = readRouterSync(root, homeSeg);
  if (!router) return null;
  const track = readTrackSync(trackFilePath, trackJournalEnabled());
  const bindings = track.prdOwners ?? {};

  for (const [task, entry] of Object.entries(router)) {
    const taskFile = readTaskFileSync(root, homeSeg, entry.prd);
    if (!taskFile) continue;
    for (const agent of resolveCandidates(agentType, taskFile, agentId, bindings)) {
      const report = readAgentReportSync(root, homeSeg, agent);
      const incomplete = incompleteSubTasks(taskFile, agent, task, report);
      if (incomplete.length === 0) continue;
      const key = stopKey(sessionId, agentId, agent);
      if (prdAlreadyBlocked(track, key)) return ""; // already blocked once — silent, but still skip trackAgentMemory
      persistStopBlocked(trackFilePath, track, key, now);
      const reason = reasonFor(agent, task, incomplete);
      // gemini-cli/cline have their OWN native block envelopes (respond()
      // already knows them: `{decision:"deny"}` / `{cancel:true}`) — the old
      // hardcoded `blockResponse` sent them the Claude `{decision:"block"}`
      // shape, which neither honors. claude-code/codex/hermes stay on
      // `blockResponse` unchanged: `respond()`'s claude-code/codex branch
      // always calls `denyResponse` (a PreToolUse-only `permissionDecision`,
      // ignored on Stop-family events — see `blockResponse`'s own doc
      // comment), and hermes's `toHermesResponse` re-wraps the reason through
      // `formatPrompt` (adds a "[BLOCKED] title" line) — neither reproduces
      // today's byte-identical `{decision:"block",reason}`.
      if (id === "kimi" || id === "gemini-cli" || id === "cline") {
        return respond(id, { kind: "block", title: "PRD sub-task incomplete", reason }, "SubagentStop");
      }
      return blockResponse(reason);
    }
  }
  return null;
}

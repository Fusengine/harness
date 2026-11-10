/**
 * @module report-recovery
 * Claude Code hands the parent the sub-agent's LAST assistant message as its result.
 * When a SubagentStop guard (sniper demand) makes the agent answer the hook, that
 * answer replaces the real report (anthropics/claude-code#85917, acknowledged as
 * current design). This module keeps the real report recoverable, as CONTEXT only:
 * - {@link recordGuardEmission} (SubagentStop, when the guard is emitted) remembers the
 *   agent and a fingerprint of its last message BEFORE the guard; only the FIRST emission
 *   of an agent run is kept (later ones see a hook reply as the last message);
 * - {@link clearGuardRecord} drops a record when a fresh stop of that agent is NOT guarded;
 * - {@link recoveredReportContext} (parent PostToolUse on the Agent tool, matched through
 *   `tool_response.agentId`) quotes that message verbatim from the agent's transcript.
 * The real tool output is never altered and the guards keep blocking exactly as before.
 * Foreground Agent results are handled here (PostToolUse); background agents (UserPromptSubmit
 * task-notification turn) in `report-background.ts`, through the shared {@link recoverReport}.
 * Storage: `report-record.ts` (one atomic file per agent); transcript reading: `report-transcript.ts`.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { contextResponse } from "../../adapters/claude";
import { FRAGMENT_CHAR_CAP } from "../inject-budget";
import { sanitizeSessionId } from "../home-state";
import { isAgentKey } from "./agent-files";
import { loadRecord, removeRecord, saveRecord, type GuardRecord } from "./report-record";
import { assistantTexts, locateReport, sha } from "./report-transcript";

/** Exact label preceding the recovered text (owner-specified). */
export const RECOVERED_LABEL = "Report recovered from the sub-agent transcript (its final message was a reply to a harness hook):";
/** One-line notice when a guarded report cannot be recovered. */
export const UNRECOVERABLE_NOTICE = "The sub-agent report could not be recovered (its final message was a reply to a harness hook and its transcript is missing, unreadable or ambiguous).";
/** Head kept inline when the report exceeds the budget (the full text stays in the transcript). */
const HEAD_CHARS = 1500;

/**
 * Remember that the sniper/receipt guard was emitted on this SubagentStop (best effort,
 * never throws): its agent id, transcript path and a fingerprint of the last assistant
 * message BEFORE the guard (`last_assistant_message`, else the transcript's last entry).
 * An existing record is kept (re-fired guard) unless the stop is fresh (`stop_hook_active === false`) or its notification was already delivered (a new run).
 * @param data - The SubagentStop payload.
 * @param sessionId - Sanitized session id.
 * @param home - Home dir.
 * @param now - Clock.
 */
export function recordGuardEmission(data: Record<string, unknown>, sessionId: string, home: string = homedir(), now: number = Date.now()): void {
  try {
    if (!isAgentKey(data.agent_id)) return;
    // First emission wins: on a re-fired guard the agent's last message is already a hook reply.
    // A fresh stop (`stop_hook_active === false`) or an already-delivered record is a NEW run: replace.
    const existing = loadRecord(sessionId, data.agent_id, home);
    if (existing && data.stop_hook_active !== false && !existing.delivered?.length) return;
    const transcript = typeof data.agent_transcript_path === "string" ? data.agent_transcript_path : "";
    const said = typeof data.last_assistant_message === "string" && data.last_assistant_message.trim() ? sha(data.last_assistant_message) : undefined;
    const entries = transcript ? assistantTexts(transcript) : null;
    const last = entries?.at(-1);
    saveRecord(sessionId, home, {
      agentId: data.agent_id,
      agentType: String(data.agent_type ?? ""),
      transcript,
      ts: new Date(now).toISOString(),
      hash: said ?? last?.hashes[0],
      lastUuid: last && (said === undefined || last.hashes.includes(said)) ? last.uuid : undefined,
    });
  } catch { /* best effort: recovery is a courtesy, never a failure of the guard */ }
}

/**
 * A SubagentStop that starts a fresh stop sequence (`stop_hook_active === false`) WITHOUT a guard
 * emission means the agent's previous run (if any) no longer applies: drop its record so a relaunch
 * never receives the previous run's report. A continuation (`true`/absent) keeps it. Never throws.
 * @param data - The SubagentStop payload.
 * @param sessionId - Sanitized session id.
 * @param home - Home dir.
 */
export function clearGuardRecord(data: Record<string, unknown>, sessionId: string, home: string = homedir()): void {
  try {
    if (data.stop_hook_active === false && isAgentKey(data.agent_id)) removeRecord(sessionId, data.agent_id, home);
  } catch { /* best effort */ }
}

/** Text of the tool response's `content` blocks (what the parent already received). */
function responseText(response: Record<string, unknown>): string {
  const c = response.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b) => (b && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n") : "";
}

/** True when `path` is an existing regular file right now. */
function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Inline form of a recovered report (verbatim, never masked, `\n` untouched). When it does not fit
 * `budget`, a head is quoted (possibly empty), explicitly marked truncated, with the absolute path of the
 * sub-agent transcript that holds the full report; `null` when that transcript no longer exists.
 */
function render(report: string, transcript: string, budget: number): string | null {
  const body = `${RECOVERED_LABEL}\n${report}`;
  if (body.length <= budget) return body;
  if (!isRegularFile(transcript)) return null;
  const marker = `\n[… report truncated inline (${report.length} chars, over the ${budget}-char hook budget); the FULL verbatim report is in the sub-agent transcript ${transcript}]`;
  const room = budget - RECOVERED_LABEL.length - 1 - marker.length;
  return `${RECOVERED_LABEL}\n${report.slice(0, Math.max(0, Math.min(HEAD_CHARS, room)))}${marker}`;
}

/**
 * Minimal pointer used when the hook output has no room for the report: only when the record's
 * transcript is the existing `agent-<id>.jsonl` regular file.
 * @param rec - The agent's guard record.
 * @returns The one-line notice, or `null` when there is no verified transcript to point to.
 */
export function limitNotice(rec: GuardRecord): string | null {
  if (!rec.transcript || basename(rec.transcript) !== `agent-${rec.agentId}.jsonl` || !isRegularFile(rec.transcript)) return null;
  return `sub-agent report not inlined: hook output limit reached; full report: ${rec.transcript}`;
}

/**
 * What the parent should be told about a guarded agent, from its record. Pure: no persistence.
 * @param rec - The agent's guard record.
 * @param received - The text the parent already received as the agent's result.
 * @param budget - Max chars of the returned text.
 * @returns The context text (verbatim report, truncation form, or the one-line notice; may exceed `budget` only when nothing smaller exists), `""` when nothing was lost.
 */
export function recoverReport(rec: GuardRecord, received: string, budget: number = FRAGMENT_CHAR_CAP): string {
  try {
    const found = locateReport(rec);
    if (!found) return UNRECOVERABLE_NOTICE;
    // The agent re-emitted its full report after the guard: nothing was lost.
    if (sha(received) === sha(found.text) || received.includes(found.text.trim())) return "";
    return render(found.text, rec.transcript, budget) ?? UNRECOVERABLE_NOTICE;
  } catch {
    return UNRECOVERABLE_NOTICE;
  }
}

/**
 * Parent PostToolUse on the Agent tool: when the finishing sub-agent had a guard emitted at
 * its SubagentStop, return `additionalContext` carrying its real report (verbatim);
 * a single notice line when it cannot be recovered; `""` for every other agent (normal stop).
 * The record is consumed (once).
 * @param payload - The PostToolUse payload (`session_id`, `tool_response.agentId`).
 * @param home - Home dir.
 * @returns A Claude `PostToolUse` context response, or `""`.
 */
export function recoveredReportContext(payload: Record<string, unknown>, home: string = homedir()): string {
  try {
    const sid = sanitizeSessionId(payload.session_id);
    const response = payload.tool_response;
    if (!sid || !response || typeof response !== "object") return "";
    const agentId = (response as { agentId?: unknown }).agentId;
    if (!isAgentKey(agentId)) return "";
    const rec = loadRecord(sid, agentId, home);
    if (!rec) return "";
    removeRecord(sid, agentId, home); // consume: once
    const text = recoverReport(rec, responseText(response as Record<string, unknown>));
    return text ? contextResponse("PostToolUse", text) : "";
  } catch {
    return contextResponse("PostToolUse", UNRECOVERABLE_NOTICE);
  }
}

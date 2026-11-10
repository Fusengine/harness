import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { contextResponse, systemMessage } from "../../adapters/claude";
import { resolveTtlSec } from "../../config/ttl";
import { loadSessionState, sanitizeSessionId, saveSessionState, sessionsDir } from "../home-state";
import { trackFile } from "../paths";
import { projectStateDir } from "../project-state-dir";
import { freshReceiptFromFile } from "../../tracking/receipts";
import { attributeFiles, filesWrittenByAgent, isAgentKey, taggedFilesOf } from "./agent-files";
import type { SessionChanges } from "./code-edit-time";
import { projectCodeFiles } from "./project-code";
import { clearGuardRecord, recordGuardEmission } from "./report-recovery";
import { receiptHint } from "./receipt-hint";

/** `~/.claude/memory/agents` — agent completion history dir. */
function memoryDir(home: string): string {
  return join(home, ".claude", "memory", "agents");
}

const SKIP_AGENTS = /(sniper|sniper-faster|explore-codebase|research-expert|claude-code-guide|Explore|Plan)/;

/** Collapse {@link receiptHint}'s full sentence into a short imperative clause for the advisory note. */
function shortReceiptHint(cwd: string, files: readonly string[]): string {
  const match = /^Run (.+?) \(exit 0, 0 failures\), then re-complete\.$/.exec(receiptHint(cwd, files));
  return match ? `run ${match[1]} before reporting done.` : "run your test suite and static checker before reporting done.";
}

/**
 * Codex parses SubagentStop stdout with `deny_unknown_fields` (codex-rs/hooks
 * schema.rs `SubagentStopCommandOutputWire`: continue, stopReason,
 * suppressOutput, systemMessage, decision, reason only), so `message` and
 * `hookSpecificOutput` fail the hook. Codex gets the same text as a
 * `systemMessage`; every other harness keeps its exact bytes.
 */
function completedOutput(id: string, text: string): string {
  return id === "codex" ? systemMessage(text) : JSON.stringify({ message: text });
}

/** Sniper reminder: Codex-valid `systemMessage`, else the unchanged `additionalContext` response. */
function reminderOutput(id: string, text: string): string {
  return id === "codex" ? systemMessage(text) : contextResponse("SubagentStop", text);
}

/** Append the agent completion record to `agent-history.jsonl` (best effort). */
function recordHistory(home: string, agentId: string, agentType: string, ts: string): void {
  const dir = memoryDir(home);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "agent-history.jsonl"), JSON.stringify({ agentId, agentType, completedAt: ts }) + "\n", "utf-8");
  } catch { /* best effort */ }
}

/**
 * Handle SubagentStop: append the completion to agent-history.jsonl and, for a
 * non-skipped agent that touched code, emit the sniper reminder + reset the
 * counter. Ports `subagent-stop/track-agent-memory.py`.
 * @param data - The raw hook payload.
 * @param home - Home dir (defaults to `~`).
 * @param now - Clock (defaults to `Date.now()`).
 * @param id - Harness adapter id (defaults to "claude-code": unchanged output).
 * @returns The native hook stdout (always JSON; Codex-schema-valid when `id` is "codex").
 */
export function trackAgentMemory(data: Record<string, unknown>, home: string = homedir(), now: number = Date.now(), id: string = "claude-code"): string {
  mkdirSync(sessionsDir(home), { recursive: true });
  const agentType = String(data.agent_type ?? data.subagent_type ?? "unknown");
  const sessionId = sanitizeSessionId(data.session_id) ?? "unknown";
  const ts = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  recordHistory(home, String(data.agent_id ?? "unknown"), agentType, ts);
  if (SKIP_AGENTS.test(agentType)) return completedOutput(id, `Agent ${agentType} completed`);
  const state = loadSessionState(sessionId, home);
  const changes = state.changes as SessionChanges | undefined;
  // Real project code only: never session-scratchpad / $TMPDIR / out-of-root probes.
  const hookCwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
  const tracked = projectCodeFiles(changes?.modifiedFiles ?? [], typeof data.cwd === "string" ? data.cwd : undefined);
  // Attribution: the files THIS agent wrote = its own transcript Writes (SubagentStop
  // `agent_transcript_path`, CLI v2.0.42+) ∪ the files its PostToolUse hooks tagged with its
  // `agent_id`. Neither available → null → session-wide list (conservative: keeps biting).
  const written = filesWrittenByAgent(typeof data.agent_transcript_path === "string" ? data.agent_transcript_path : undefined);
  const tagged = taggedFilesOf(changes, data.agent_id);
  const attributed = written === null && tagged === null ? null : [...(written ?? []), ...(tagged ?? [])];
  // Dedupe key: the agent id, else its own transcript path; neither → no dedupe (keeps biting).
  const agentKey = isAgentKey(data.agent_id) ? data.agent_id : typeof data.agent_transcript_path === "string" ? data.agent_transcript_path : "";
  let fresh: string[];
  if (attributed === null) {
    // Legacy session-wide fallback: gated by the shared counter, which the first owner zeroes.
    fresh = (changes?.cumulativeCodeFiles ?? 0) > 0 ? tracked : [];
  } else {
    // Per-agent judgement: each agent is held for ITS files whatever another agent already
    // zeroed on the shared counter; a file is demanded once PER AGENT (`remindedAt`,
    // keyed `<agent_id>\0<file>`), so a second author of the same file is still held for it.
    // A file edited AFTER the previous demand (`editedAt` > `remindedAt`) is demanded again.
    const reminded = changes?.remindedAt ?? {};
    fresh = attributeFiles(tracked, attributed).filter((f) => {
      const at = Object.hasOwn(reminded, `${agentKey}\0${f}`) ? reminded[`${agentKey}\0${f}`] : undefined;
      return agentKey === "" || at === undefined || (changes?.editedAt?.[f] ?? -Infinity) > at;
    });
  }
  // Only reset when this agent owns changes — an agent that touched none of the tracked
  // files never clears them for the real author, nor is told to validate a teammate's work.
  if (fresh.length > 0) {
    const remindedAt = { ...(changes?.remindedAt ?? {}), ...Object.fromEntries(fresh.map((f) => [`${agentKey}\0${f}`, now])) };
    saveSessionState(sessionId, { ...state, changes: { ...changes, cumulativeCodeFiles: 0, remindedAt } }, home);
    // Never demand sniper on a file the agent deleted before stopping (e.g. a scratch
    // probe rm -rf'd): the tracked list records writes, never removals — re-check the disk
    // (a relative path resolves against the hook cwd).
    const present = fresh.filter((f) => existsSync(resolve(hookCwd, f)));
    if (present.length > 0) {
      // Advisory (no hard block here — the TaskCompleted gate enforces): flag the
      // missing proof when the agent owns code but posted no fresh passing receipt.
      // Window = TTL×5, matching the TaskCompleted receipt gate.
      const windowMs = resolveTtlSec(process.env) * 1000 * 5;
      const noReceipt = freshReceiptFromFile(trackFile(sessionId, projectStateDir(process.cwd())), windowMs, now) === null;
      const note = noReceipt ? ` NO VERIFICATION RECEIPT — ${shortReceiptHint(hookCwd, present)}` : "";
      // Report recovery (Claude Code only): remember that this stop's final message gets
      // displaced by the agent's reply to the guard, so the parent can recover the report.
      if (id === "claude-code") recordGuardEmission(data, sessionId, home, now);
      return reminderOutput(id, `SNIPER VALIDATION REQUIRED: Agent '${agentType}' modified ${present.length} code file(s): ${present.join(", ")}. Run sniper agent now.${note}`);
    }
  }
  // A fresh (non-continuation) stop with NO guard emitted: this agent's previous run, if any, no longer applies.
  if (id === "claude-code") clearGuardRecord(data, sessionId, home);
  return completedOutput(id, `Agent ${agentType} completed (no code changes)`);
}

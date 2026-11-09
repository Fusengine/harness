import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { contextResponse, systemMessage } from "../../adapters/claude";
import { resolveTtlSec } from "../../config/ttl";
import { loadSessionState, sanitizeSessionId, saveSessionState, sessionsDir } from "../home-state";
import { trackFile } from "../paths";
import { projectStateDir } from "../project-state-dir";
import { freshReceiptFromFile } from "../../tracking/receipts";
import { attributeFiles, filesWrittenByAgent } from "./agent-files";
import { receiptHint } from "./receipt-hint";

/** The `changes` block written by `track-changes.ts` into unified session state. */
interface Changes {
  cumulativeCodeFiles?: number;
  modifiedFiles?: string[];
}

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
  const changes = state.changes as Changes | undefined;
  const count = changes?.cumulativeCodeFiles ?? 0;
  if (count > 0) {
    // Attribute only the files THIS agent actually wrote, parsed from its own
    // transcript (SubagentStop `agent_transcript_path`, CLI v2.0.42+). When the
    // field is absent or the transcript is unreadable, `filesWrittenByAgent`
    // returns null → fall back to the session-wide list (no regression).
    const written = filesWrittenByAgent(typeof data.agent_transcript_path === "string" ? data.agent_transcript_path : undefined);
    const owned = written === null ? (changes?.modifiedFiles ?? []) : attributeFiles(changes?.modifiedFiles ?? [], written);
    // Only reset the session counter when this agent owns changes — so an agent
    // that touched none of the tracked files never clears them for the real
    // author, and never gets told to validate another teammate's work.
    if (owned.length > 0) {
      saveSessionState(sessionId, { ...state, changes: { ...changes, cumulativeCodeFiles: 0 } }, home);
      // Never demand sniper on a file the agent deleted before stopping (e.g. a
      // scratch probe rm -rf'd): the tracked list records writes, never removals,
      // so re-check the disk (a relative path resolves against the hook cwd) and
      // keep only files still present. All gone → nothing to validate → "no changes".
      const hookCwd = typeof data.cwd === "string" ? data.cwd : process.cwd();
      const present = owned.filter((f) => existsSync(resolve(hookCwd, f)));
      if (present.length > 0) {
        // Advisory (no hard block here — the TaskCompleted gate enforces): flag the
        // missing proof when the agent owns code but posted no fresh passing receipt.
        // Window = TTL×5, matching the TaskCompleted receipt gate.
        const windowMs = resolveTtlSec(process.env) * 1000 * 5;
        const noReceipt = freshReceiptFromFile(trackFile(sessionId, projectStateDir(process.cwd())), windowMs, now) === null;
        const note = noReceipt ? ` NO VERIFICATION RECEIPT — ${shortReceiptHint(hookCwd, present)}` : "";
        return reminderOutput(id, `SNIPER VALIDATION REQUIRED: Agent '${agentType}' modified ${present.length} code file(s): ${present.join(", ")}. Run sniper agent now.${note}`);
      }
    }
  }
  return completedOutput(id, `Agent ${agentType} completed (no code changes)`);
}

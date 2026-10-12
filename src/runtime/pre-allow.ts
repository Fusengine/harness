/**
 * PreToolUse ALLOW-path response assembly. Reached only after every gate
 * allowed (a deny/ask already returned upstream), so nothing here can block nor
 * override a decision. Combines the Python-parity pass notice (systemMessage)
 * with the single most-specific decision-time lesson (additionalContext), plus
 * a compact "evidence fresh" compliance notice on the first APEX-scoped code
 * Write/Edit that clears the freshness gate.
 */
import { designPassNotice } from "../policy/design/gates";
import { resolveCorpusRoot } from "../policy/design/corpus";
import { lessonFor } from "../policy/lessons/lesson-gate";
import { lessonsFileFor } from "./lifecycle/lessons/state";
import { projectRoot } from "../util/project-root";
import { oncePerWindow } from "./inject-dedup";
import { sessionLessonOnce } from "./inject-session/lesson-once";
import { defaultStateDir } from "./paths";
import { isApexScoped } from "./gate-helpers";
import { REQUIRED_AGENTS, DEFAULT_WINDOW_MS } from "./gate";
import { agentsFreshInTrack } from "../freshness/agent-evidence-record";
import { loadTrack } from "../tracking/store";
import { evidenceFreshNotice } from "./notices";
import { respond } from "./respond";
import type { NormalizedEvent } from "./normalize";
import type { HandleOutcome } from "./handle";
import type { Prompt } from "../prompt/types";

/** Session-track + clock inputs the "evidence fresh" notice needs (absent = feature off, e.g. no caller-provided track file). */
export interface EvidenceCheck {
  /** Session track file path (same one the gate chain reads/writes). */
  trackFile: string;
  /** APEX freshness window in ms (defaults to {@link DEFAULT_WINDOW_MS}). */
  windowMs?: number;
  /** Event clock. */
  now: number;
}

/**
 * `✓ evidence fresh (explore+research)` for the first APEX-scoped Write/Edit
 * that finds explore-codebase + research-expert evidence still within the
 * freshness window — the user-visible confirmation for a gate that, until now,
 * only ever spoke up when it BLOCKED. Deduped once per freshness window per
 * session (same window the gate itself re-validates on), so it reads as "just
 * confirmed", not a notice on every edit. Returns null for anything but a
 * Write/Edit on an APEX-scoped path, or when evidence isn't fresh.
 */
async function freshEvidenceNotice(event: NormalizedEvent, evidence: EvidenceCheck, cwd: string): Promise<string | null> {
  if ((event.tool !== "Write" && event.tool !== "Edit") || !isApexScoped(event.filePath)) return null;
  const windowMs = evidence.windowMs ?? DEFAULT_WINDOW_MS;
  const track = await loadTrack(evidence.trackFile);
  if (!agentsFreshInTrack(track, REQUIRED_AGENTS, windowMs, evidence.now)) return null;
  if (!oncePerWindow(`evidence-fresh:${event.sessionId}`, windowMs, { now: evidence.now, dir: defaultStateDir(cwd) })) return null;
  return evidenceFreshNotice();
}

/**
 * Build the native outcome for a PreToolUse call that passed every gate: emit a
 * user-visible pass notice (once per allowed call), the "evidence fresh"
 * compliance notice when applicable, and, when its TRIGGERS match this call,
 * the one cooldown-guarded decision-time lesson. All 3 channels ride a single
 * response (lesson → additionalContext, notices → systemMessage).
 * @param id - Harness id for {@link respond}.
 * @param event - The normalized PreToolUse event.
 * @param payload - The raw hook payload (for `agent_id`).
 * @param mcpDir - MCP state dir backing the pass-notice throttle.
 * @param cwd - Project root (lesson file + notice scope).
 * @param evidence - Session track + clock for the "evidence fresh" notice (omit to disable it).
 * @returns The native hook outcome (empty stdout when nothing to emit).
 */
export async function allowOutcome(
  id: string,
  event: NormalizedEvent,
  payload: Record<string, unknown>,
  mcpDir: string,
  cwd: string,
  evidence?: EvidenceCheck,
  corpusRoot?: string,
): Promise<HandleOutcome> {
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  const notice = designPassNotice({
    agentId,
    tool: event.tool, filePath: event.filePath ?? "", content: event.content ?? "",
    url: typeof event.input.url === "string" ? event.input.url : "", phase: "pre",
    corpusMissing: agentId !== "" && (corpusRoot ?? resolveCorpusRoot()) === "",
  }, mcpDir);
  // Claude Code: once per session/sub-agent (the shared-JSON window was pruned by short-window callers); other hosts keep oncePerWindow.
  const once = id === "claude-code" && process.env.CLAUDE_PROJECT_DIR ? sessionLessonOnce(event.sessionId, agentId, cwd, undefined, oncePerWindow) : oncePerWindow;
  const lesson = lessonFor(event.tool, event.input, { file: lessonsFileFor(projectRoot(cwd)), once });
  const evidenceNotice = evidence ? await freshEvidenceNotice(event, evidence, cwd) : null;
  if (lesson) {
    const userMessage = [notice?.userMessage, evidenceNotice].filter(Boolean).join("\n") || undefined;
    const merged = userMessage ? { ...lesson, userMessage } : lesson;
    return { stdout: respond(id, merged, event.eventName ?? "PreToolUse"), exit: 0 };
  }
  if (evidenceNotice) {
    const userMessage = [notice?.userMessage, evidenceNotice].filter(Boolean).join("\n");
    const prompt: Prompt = notice ? { ...notice, userMessage } : { kind: "inform", title: "APEX freshness", reason: "", userMessage };
    return { stdout: respond(id, prompt, event.eventName ?? "PreToolUse"), exit: 0 };
  }
  return { stdout: notice ? respond(id, notice, event.eventName ?? "PreToolUse") : "", exit: 0 };
}

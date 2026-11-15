import { blockResponse } from "../../adapters/claude";
import { classifyFinalMessage } from "../../policy/lead-guards/outcome-only";
import { LEAD_GUARD_ENV, OUTCOME_BLOCK_REASON } from "../../policy/lead-guards/markers";
import { turnStartedByOwner } from "./transcript-owner";

/**
 * Lead outcome guard (Stop): block a turn that ends on a status-only relay. Blocks only when ALL hold:
 * Claude Code lead session (`Stop`, no `agent_id`); guard not disabled (`FUSE_LEAD_OUTCOME_GUARD=0`);
 * Claude Code is not already continuing from a stop hook (`stop_hook_active` false: never two blocks in a
 * row); the final message (`last_assistant_message`) carries no outcome marker and no owner action; and
 * the transcript proves the turn was NOT started by an owner message (an answer to the owner is never a relay).
 * Every undecidable case (no message, no transcript, unreadable file) lets the turn end.
 * @param payload - The raw Stop hook payload.
 * @param id - Harness adapter id.
 * @param env - Environment (injectable for tests).
 * @returns The native block stdout, or `""` to let the turn end.
 */
export function outcomeStopGate(payload: Record<string, unknown>, id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (id !== "claude-code" || env[LEAD_GUARD_ENV.outcome] === "0") return "";
  if (payload.stop_hook_active === true || typeof payload.agent_id === "string") return "";
  const message = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
  if (!message.trim() || !classifyFinalMessage(message).relayLike) return "";
  const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcript || turnStartedByOwner(transcript, message) !== false) return "";
  return blockResponse(OUTCOME_BLOCK_REASON);
}

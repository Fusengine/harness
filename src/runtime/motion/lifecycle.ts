import { homedir } from "node:os";
import { addActiveCritic, removeActiveCritic, isCriticAgentType } from "../../policy/motion/critic-flag";
import { pruneInflight, releaseSessionRenders } from "../../policy/motion/budget";
import { sessionMotionStates } from "../../policy/motion/state";

/**
 * SubagentStart/SubagentStop: track active `motion-critic` agents per session.
 * Removal is by `agent_id` ALONE, whatever the `agent_type` (a stuck flag would
 * sandbox the whole session forever).
 * @param event - Raw hook event name.
 * @param payload - Raw hook payload.
 * @param sessionId - Normalized session id.
 * @param home - OS home override.
 */
export function motionSubagent(event: string, payload: Record<string, unknown>, sessionId: string, home: string = homedir()): void {
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  if (!agentId) return;
  if (event === "SubagentStop") {
    removeActiveCritic(sessionId, agentId, home);
    return;
  }
  const agentType = typeof payload.agent_type === "string" ? payload.agent_type : "";
  if (isCriticAgentType(agentType)) addActiveCritic(sessionId, agentId, home);
}

/**
 * SubagentStop (claude-code only — see `stopReleasesRenders`):
 * best-effort release of the STOPPED sub-agent's FRESH in-flight render
 * reservations, so a tool that never ran cannot hold the master cap forever.
 * Only entries written with the exact same `agent_id` can match, so the
 * release is safe on every host version; a fresh reservation of any other
 * agent (or of the main turn) keeps blocking. TTL-expired reservations are
 * first moved to the retained `expired` map and stay settleable for a render
 * still running past the TTL. The main turn's Stop never calls this: a
 * main-turn leak falls by the TTL alone.
 * A corrupt or busy budget is left untouched (fail-closed; the TTL is the
 * backstop) and never changes the SubagentStop output. Pre-0.1.104 entries
 * carry no sessionId and expire by TTL only. State receipts are left in
 * place: a still-running tool keeps its completion attribution, and the next
 * render pre drops orphaned receipts whose reservation is gone.
 * @param sessionId - Session whose sub-agent stopped.
 * @param agentId - Stopped sub-agent id (non-empty; the caller guarantees it).
 * @param home - OS home override.
 * @param now - Epoch ms for the TTL partition.
 */
export function motionSessionStop(sessionId: string, agentId: string, home: string = homedir(), now: number = Date.now()): void {
  for (const state of sessionMotionStates(sessionId, home)) {
    try { pruneInflight(state.project.root, now, home); }
    catch { /* best-effort: stale entries stay in-flight and expire by TTL at the next admission */ }
    try { releaseSessionRenders(state.project.root, sessionId, home, agentId); }
    catch { /* best-effort: the reservation stays and expires by TTL */ }
  }
}

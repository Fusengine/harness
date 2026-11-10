/**
 * @module inject-budget-recap
 * ONE event-level recap of every {@link module:inject-budget.capFragment}
 * -tracked fragment injected for a SessionStart/SubagentStart event — the
 * aggregated view the per-fragment caps never gave: each injection point
 * (dev-context, snapshot sections, lessons, apex-subagent, ...) caps and
 * reports itself in ISOLATION, with no total across the whole event.
 *
 * Rides the user-visible `systemMessage` channel, Claude-Code-only (gate at
 * the call site — mirrors the existing `id === "claude-code"` pattern for
 * `designLifecycle` in handle.ts): other adapters do not all re-export
 * `attachSystemMessage`, and stamping a Claude-shaped envelope onto another
 * harness's stdout shape would be silently wrong there.
 *
 * Deduped via {@link module:inject-dedup.onceExclusive}, not the JSON
 * `oncePerWindow`: SessionStart/SubagentStart fan out across every installed
 * plugin exactly like PostToolUse does (see burst-window.ts) — a shared-JSON
 * read-modify-write here would risk the same lost-update race already fixed
 * for the sniper reminder (lesson 2026-07-05 16:00).
 * @packageDocumentation
 */
import { attachSystemMessage } from "../adapters/claude";
import { budgetReport } from "./inject-budget";
import { fragmentRegistry } from "./fragment-registry";
import { onceExclusive } from "./inject-dedup";
import { BURST_DEDUP_MS } from "./burst-window";
import { projectStateDir } from "./project-state-dir";

/**
 * Attach the aggregated recap onto `stdout` when 2+ fragments were recorded
 * for `rawEvent`. A lone fragment already carries its own visibility (its
 * producer's own per-fragment report, when it has one) — no recap is added
 * for that case, so the common single-fragment event stays noise-free.
 * @param stdout - The already-rendered hook stdout for this event.
 * @param rawEvent - The raw hook event name (only SessionStart/SubagentStart qualify; others pass through unchanged).
 * @param sessionId - Current session id (dedup scope).
 * @param cwd - Project root (state-dir scope for the dedup marker).
 * @param now - Clock.
 * @returns `stdout` with a `systemMessage` recap attached, or `stdout` unchanged.
 */
export function attachBudgetRecap(stdout: string, rawEvent: string, sessionId: string, cwd: string, now: number): string {
  if (rawEvent !== "SessionStart" && rawEvent !== "SubagentStart") return stdout;
  const fragments = fragmentRegistry();
  if (fragments.length <= 1) return stdout;
  if (!onceExclusive(`budget:${sessionId}:${rawEvent}`, BURST_DEDUP_MS, { now, dir: projectStateDir(cwd) })) return stdout;
  return attachSystemMessage(stdout, budgetReport(fragments));
}

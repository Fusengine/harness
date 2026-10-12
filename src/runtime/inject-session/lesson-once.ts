/**
 * @module inject-session/lesson-once
 * Session-scoped replacement of the 30-min `oncePerWindow` cooldown that gates
 * the PreToolUse decision-time lesson note on Claude Code. The shared-JSON
 * cooldown was pruned by every short-window caller of the same sidecar
 * (`inject-dedup.json`), so the same lesson was re-sent on every matching tool
 * call (741 times in one measured session). Here a lesson is delivered once
 * per session (per sub-agent: its context is fresh) and again only after the
 * context is rebuilt (SessionStart epoch reset). The hooks-loader's duplicate
 * copy never claims (HEAD behaviour via `fallback`).
 */
import { sanitizeSessionId } from "../home-state";
import type { OncePerWindow } from "../../policy/lessons/types";
import { injectStateDir, openScope, scopeName, unitHash } from "./registry";
import { claim } from "./units";
import { isLoaderChild } from "./loader-child";

/**
 * Build the `once` gate handed to `lessonFor` for Claude Code.
 * @param sessionId - The hook's session id ("" or invalid = no session: always allow, never silently drop a lesson).
 * @param agentId - The sub-agent id when the call runs inside a sub-agent, else "".
 * @param cwd - Project root (state-dir scope).
 * @param home - Test-only home override.
 * @param fallback - Gate used by the hooks-loader duplicate copy (HEAD's cooldown).
 * @returns A gate returning true exactly once per (session or sub-agent, lesson, epoch).
 */
export function sessionLessonOnce(sessionId: string, agentId: string, cwd: string, home?: string, fallback?: OncePerWindow): OncePerWindow {
  const sid = sanitizeSessionId(sessionId);
  const agent = sanitizeSessionId(agentId);
  return (key: string, windowMs: number): boolean => {
    if (!sid) return true;
    if (fallback && isLoaderChild()) return fallback(key, windowMs);
    try {
      return claim(openScope(injectStateDir(cwd, home), scopeName(sid, agent)), unitHash(key));
    } catch {
      return true;
    }
  };
}

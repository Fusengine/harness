/**
 * Cursor SubagentStop wiring for {@link mergeChildEvidence}: a Cursor sub-agent
 * runs under its own `conversation_id`, and its evidence sits in that child
 * track. Cursor's real `subagentStop` payload carries `child_conversation_id`
 * (observed live; not yet in the public hooks doc) next to the parent's
 * `session_id`. Absent, empty or equal to the parent → no-op: the behavior is
 * exactly the former one. Fail-open: never throws out of the hook.
 */
import { mergeChildEvidence } from "./child-evidence-merge";
import { readTrackAnySync, updateTrackSync } from "./evidence-harvest-io";
import { trackFile } from "../runtime/paths";
import { sanitizeSessionId } from "../runtime/home-state";
import { projectStateDir } from "../runtime/project-state-dir";

/**
 * Fold the finished Cursor sub-agent's track into its parent session track.
 * @param payload - The raw Cursor `subagentStop` payload.
 * @param cwd - Project root (selects the per-project state dir).
 * @param now - Event timestamp.
 * @param baseDir - Override the track base dir (tests).
 */
export function mergeCursorChildTrack(payload: Record<string, unknown>, cwd: string, now: number, baseDir: string = projectStateDir(cwd)): void {
  try {
    const parent = sanitizeSessionId(payload.session_id ?? payload.conversation_id);
    const child = sanitizeSessionId(payload.child_conversation_id);
    if (!parent || !child || parent === child) return;
    const childTrack = readTrackAnySync(trackFile(child, baseDir));
    if (childTrack.agents.length === 0 && childTrack.refsRead.length === 0 && Object.keys(childTrack.authorizations).length === 0) return;
    updateTrackSync(trackFile(parent, baseDir), now, (track) => mergeChildEvidence(track, childTrack, parent));
  } catch {
    // A lifecycle hook must never throw.
  }
}

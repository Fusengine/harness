/**
 * fuse-lessons write-mark + Stop-reminder, scoped by `session_id` when present.
 *
 * WITH a session id (normal Claude Code): each `(session, root)` pair carries
 * its own edit/reminder throttle in {@link module:memory/session-roots}, so a
 * Stop lists and silences ONLY the roots THAT session edited — concurrent
 * sessions on different projects never cross-remind nor steal each other's
 * throttle. WITHOUT a usable session id (a harness that omits it, or the legacy
 * on-disk state) it falls back to the original mono-session behavior: the global
 * flat root registry + the per-project `MEMORY/state.json` throttle.
 */
import { dirname, resolve } from "node:path";
import { contextResponse } from "../../../adapters/claude";
import { sanitizeSessionId } from "../../home-state";
import { addRoot, readRoots } from "../../../memory/registry";
import { collectSessionPending, markSessionRoot } from "../../../memory/session-roots";
import { nowStamp, readState, setStateField, throttleMs } from "../../../memory/state";
import { isCodeFile, projectRootOrNull } from "../../../util/project-root";
import { lessonsStateFileFor } from "./state";

/** Sanitized session id from a raw hook payload, or null (→ legacy fallback). */
function sessionOf(payload: Record<string, unknown>): string | null {
  return sanitizeSessionId(payload.session_id);
}

/** Legacy (no session id): pending roots across the global flat registry. */
function collectLegacyPending(now: number, window: number): string[] {
  const pending: string[] = [];
  for (const root of readRoots()) {
    const stateFile = lessonsStateFileFor(root);
    const { lastRemindedAt, lastCodeEditAt } = readState(stateFile);
    if (lastCodeEditAt <= lastRemindedAt) continue;
    if (now - lastRemindedAt < window) continue;
    pending.push(root);
    setStateField(stateFile, "lastRemindedAt", now);
  }
  return pending;
}

/** Stop reminder body listing each pending project's lessons file. */
function reminderText(pending: string[]): string {
  const stamp = nowStamp();
  const targets = pending.map((r) => `- ${r}/MEMORY/LESSON.md`).join("\n");
  return `Before ending: if this session hit a mistake/blocker worth never ` +
    `reproducing, append 1-3 COMPACT bullets OR sharpen/merge existing ones ` +
    `(format \`- [${stamp}] what went wrong → do instead\`, use exactly this ` +
    `timestamp) in each project's lessons file below. Write bullets in ` +
    `caveman style: telegraphic English, no articles/filler, fragments, ` +
    `symbols (→ = + ×), never drop not/never/no/only, keep ` +
    `commands/paths/numbers/identifiers verbatim. ` +
    `Skip if nothing notable.\n${targets}`;
}

/**
 * Stop: emit one reminder covering the stopping session's pending projects.
 * @param payload - Raw hook payload (`session_id` selects the scoped path).
 * @param now - Clock.
 * @returns Native Stop stdout, or "" when nothing is pending.
 */
export function remindWrite(payload: Record<string, unknown>, now: number): string {
  const window = throttleMs();
  const sid = sessionOf(payload);
  const pending = sid ? collectSessionPending(sid, now, window) : collectLegacyPending(now, window);
  if (pending.length === 0) return "";
  return contextResponse("Stop", reminderText(pending));
}

/**
 * PostToolUse: record the edit against the throttle. A code file arms the
 * reminder; writing `MEMORY/LESSON.md` silences it (the lesson was just saved).
 * Session-scoped when `session_id` is present, else the legacy global path.
 * @param payload - Raw hook payload (`tool_input.file_path`, `session_id`).
 * @param now - Clock.
 */
export function markWrite(payload: Record<string, unknown>, now: number): void {
  const input = payload.tool_input as { file_path?: string } | undefined;
  if (!input?.file_path) return;
  const abs = resolve(input.file_path);
  const root = projectRootOrNull(dirname(abs));
  if (!root) return;
  const isLesson = abs === resolve(root, "MEMORY", "LESSON.md");
  if (!isLesson && !isCodeFile(abs)) return;
  const sid = sessionOf(payload);
  if (sid) {
    markSessionRoot(sid, root, isLesson ? "remindedAt" : "editedAt", now);
  } else if (isLesson) {
    setStateField(lessonsStateFileFor(root), "lastRemindedAt", now);
  } else {
    setStateField(lessonsStateFileFor(root), "lastCodeEditAt", now);
    addRoot(root);
  }
}

/**
 * fuse-lessons scope dispatch (TS port of the 4 handler scripts). Routes by
 * event: SessionStart/SubagentStart inject `MEMORY/LESSON.md`; Stop reminds the
 * stopping session about ITS OWN projects with unsaved code edits; PostToolUse
 * marks the write to arm/silence the throttle. The reminder + mark logic (incl.
 * the per-`session_id` scoping that fixes the multi-session misdirection) lives
 * in {@link module:runtime/lifecycle/lessons/reminder}; this module keeps the
 * event router + lesson-file injection. Non-fatal by design.
 */
import { existsSync, readFileSync } from "node:fs";
import { renderInform } from "../../inform";
import { projectRoot } from "../../../util/project-root";
import { atomicWrite } from "../../../util/json-io";
import { curateLessons } from "../aipilot/curate-lessons";
import { compressInjection } from "../aipilot/lesson-inject";
import { capFragment } from "../../inject-budget";
import { lessonsArchiveFileFor, lessonsFileFor } from "./state";
import { markWrite, remindWrite } from "./reminder";

/**
 * Persist a curation ATOMICALLY and ARCHIVE-FIRST for zero-loss: prepend the
 * moved bullets to LESSON-archive.md, THEN rewrite LESSON.md. On ANY write error
 * the original file is left untouched (returns `original`) so a bullet is never
 * lost — a rare archive-then-trim-fail leaves a duplicate (never a loss), which
 * the next dedup pass reconciles.
 */
function persistCuration(file: string, root: string, curated: string, archive: string, original: string): string {
  try {
    if (archive) {
      const af = lessonsArchiveFileFor(root);
      const prev = existsSync(af) ? readFileSync(af, "utf-8") : "";
      atomicWrite(af, prev ? `${archive}\n${prev}` : archive);
    }
    atomicWrite(file, curated);
    return curated;
  } catch { return original; }
}

/**
 * Inject `MEMORY/LESSON.md` for `event`. Mechanical curation (dedup + cap→archive)
 * rewrites the FILE; the injected BLOCK is then COMPRESSED (newest bullets whole,
 * older ones distilled to their rule) so a growing file never inflates the
 * SessionStart/SubagentStart context. A hard {@link capFragment} budget is the
 * last-resort backstop on top of compression — the regression that motivated it
 * was this exact block silently reaching ~44k tokens. Any curation report
 * surfaces via systemMessage.
 */
function injectMemory(cwd: string, event: string, now: number, id: string): string {
  const root = projectRoot(cwd);
  const file = lessonsFileFor(root);
  if (!existsSync(file)) return "";
  let content = "";
  try { content = readFileSync(file, "utf-8").trim(); } catch { return ""; }
  if (!content) return "";
  const { content: curated, archive, report } = curateLessons(content, now, root);
  if (curated !== content) content = persistCuration(file, root, curated, archive, content);
  const body = capFragment("lessons", compressInjection(content));
  const ctx = `Project lessons — never reproduce these:\n${body}\nYou may append OR refine/merge/dedupe bullets in MEMORY/LESSON.md — caveman style: telegraphic, no filler, never drop not/never/no/only, keep commands/paths/numbers verbatim.`;
  const notice = report ? `lessons injected\nLESSON.md curation:\n${report}` : "lessons injected";
  return renderInform(id, event, ctx, notice);
}

/**
 * Route a fuse-lessons event to its handler. Returns the native stdout for
 * context-injecting events (SessionStart/SubagentStart/UserPromptSubmit inject
 * MEMORY/LESSON.md, Stop reminds) or "" for the side-effect-only PostToolUse mark.
 * @param event - The raw hook event name.
 * @param payload - The raw hook payload.
 * @param cwd - Project root for memory injection.
 * @param now - Clock.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The native stdout (possibly empty).
 */
export function dispatchLessons(event: string, payload: Record<string, unknown>, cwd: string, now: number, id: string = "claude-code"): string {
  switch (event) {
    case "SessionStart":
    case "SubagentStart":
    case "UserPromptSubmit":
      return injectMemory(cwd, event, now, id);
    case "Stop":
      return remindWrite(payload, now);
    case "PostToolUse":
      markWrite(payload, now);
      return "";
    default:
      return "";
  }
}

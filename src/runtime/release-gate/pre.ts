import type { Prompt } from "../../prompt/types";
import { resolveProjectDir } from "../../util/project-dir";
import { lastCodeEditAt } from "../lifecycle/code-edit-time";
import type { NormalizedEvent } from "../normalize";
import type { HandleOptions } from "../handle";
import { releaseGatePrompt } from "./gate";

/**
 * PreToolUse adapter: the release-gate prompt for this event, or `null`.
 * Only runs when every other gate allowed (the caller keeps existing verdicts
 * untouched) and only for events carrying a shell command. Fail-open on any
 * internal error (a gate bug must never block unrelated work).
 * @param event - Normalized event.
 * @param opts - Handle options (cwd, clock, test home).
 */
export function releasePrompt(event: NormalizedEvent, opts: HandleOptions): Prompt | null {
  if (!event.command) return null;
  try {
    return releaseGatePrompt(event.command, {
      projectDir: resolveProjectDir(event.cwd ?? opts.cwd),
      lastEdit: lastCodeEditAt(event.sessionId, opts.home),
      now: opts.now ?? Date.now(),
      home: opts.home,
    });
  } catch {
    return null;
  }
}

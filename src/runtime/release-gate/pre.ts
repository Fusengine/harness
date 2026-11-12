import type { Prompt } from "../../prompt/types";
import { resolveProjectDir } from "../../util/project-dir";
import { lastCodeEditAt } from "../lifecycle/code-edit-time";
import type { NormalizedEvent } from "../normalize";
import type { HandleOptions } from "../handle";
import { releaseGatePrompt } from "./gate";

/**
 * PreToolUse adapter: the release-gate prompt for this event, or `null`.
 * Only runs when every other gate allowed (the caller keeps existing verdicts
 * untouched) and only for events carrying a shell command. If the gate itself
 * crashes, a command that LOOKS like a release step (`gh pr merge`, `git tag`)
 * is asked (fail-closed: a broken gate never waves a merge through), any other
 * command stays allowed (a gate bug must never block unrelated work).
 * @param event - Normalized event.
 * @param opts - Handle options (cwd, clock, test home).
 * @param gate - Gate implementation (tests inject a crashing one).
 */
export function releasePrompt(event: NormalizedEvent, opts: HandleOptions, gate: typeof releaseGatePrompt = releaseGatePrompt): Prompt | null {
  if (!event.command) return null;
  try {
    return gate(event.command, {
      projectDir: resolveProjectDir(event.cwd ?? opts.cwd),
      lastEdit: lastCodeEditAt(event.sessionId, opts.home),
      now: opts.now ?? Date.now(),
      home: opts.home,
    });
  } catch {
    return RELEASE_LIKE.test(event.command)
      ? {
          kind: "ask",
          ruleId: "release-gate",
          title: "Release gate unavailable",
          reason: "The release gate crashed while checking this command, which looks like a release step (gh pr merge / git tag). Failing closed.",
          actions: ["Run fuse-ai-pilot:sniper then fuse-ai-pilot:challenger, then retry", "Or approve explicitly if this release is intended"],
        }
      : null;
  }
}

/** Coarse, parser-independent release-step shape used only when the gate crashed. */
const RELEASE_LIKE = /\bgh\b[^;&|\n]*\bpr\b[^;&|\n]*\bmerge\b|\bgit\b[^;&|\n]*\btag\b|\bmerge\b[^;&|\n]*\bgh\b/;

/**
 * Solid-scope PreToolUse outcome: the file-size deny ({@link solidFileSizeGate})
 * first — rendered via {@link respond} so every harness gets its native shape
 * (Kimi finally receives a real `hookSpecificOutput` deny instead of a leaked
 * Claude envelope) — then the ported Go/Python interface-location check
 * ({@link validateSolidGate}, kept byte-identical for claude-code/codex).
 * Owns the whole solid-scope branch so `handle-pre` stays a dispatcher and the
 * branch NEVER falls through to the core APEX/SOLID gate chain: core-guards
 * owns it, so falling through would run `gate()` twice per edit when both
 * plugins wire PreToolUse Write|Edit (duplicate denies + added latency). For
 * the same reason the file-size gate itself ABSTAINS when core-guards is
 * installed ({@link coreGuardsWired}): one tool-call, one deny, whoever fires.
 */
import { dirname } from "node:path";
import { withDenyNotice } from "./deny-notice";
import { respond } from "./respond";
import { validateSolidGate } from "./lifecycle";
import { solidFileSizeGate } from "./solid-file-size-gate";
import { coreGuardsWired } from "./core-guards-wired";
import type { NormalizedEvent } from "./normalize";
import type { HandleOutcome } from "./handle-types";

/**
 * Run the solid-scope PreToolUse gates and render the native hook outcome.
 * @param id - Harness id (selects the response shape via {@link respond}).
 * @param event - The normalized hook event.
 * @param file - Session track file (the deny-notice state derives from its dir).
 * @param now - Current time in ms.
 * @param env - Environment for the core-guards wiring probe (injectable).
 * @returns The hook outcome: file-size deny, Go/Python deny, or allow.
 */
export function solidScopeOutcome(
  id: string,
  event: NormalizedEvent,
  file: string,
  now: number,
  env: Record<string, string | undefined> = process.env,
): HandleOutcome {
  const prompt = coreGuardsWired(id, env)
    ? null
    : solidFileSizeGate(
      event.tool,
      event.filePath,
      event.content,
      event.oldString,
      event.input.replace_all === true,
      event.agentType,
      id,
    );
  if (prompt) {
    return { stdout: withDenyNotice(id, respond(id, prompt), prompt, event.sessionId, dirname(file), now), exit: 0 };
  }
  return { stdout: validateSolidGate(event.tool, event.filePath ?? "", event.content ?? ""), exit: 0 };
}

import type { Prompt } from "../../prompt/types";
import { displayCodeForAction, hashForAction } from "./confirm-code";
import { isIrreversible } from "./confirm-irreversible";
import { withTrashHint } from "./confirm-rm";
import { recordPendingDeny } from "./confirm-pending";
import { consumeConfirmToken } from "./confirm-state";
import { authorizeCodexAction, codexAction } from "./codex-confirm";
import { subagentFrozenUntil } from "./confirm-subagent";

/**
 * Harnesses where `respond.ts` silently downgrades `kind: "ask"` to a hard
 * deny (Codex: `case "codex"`; Kimi: `toKimiResponse` maps `ask` to the same
 * `permissionDecision:"deny"` envelope as `block`; Cursor: `respond.ts` maps
 * `ask` to `permission:"deny"` — its `beforeSubmitPrompt` carries `prompt` +
 * the same `session_id` as `preToolUse`, so the shared submit path arms the
 * token). Claude Code keeps native interactive `ask` — this mechanism NEVER
 * applies there.
 */
const DEGRADES_ASK_TO_DENY: ReadonlySet<string> = new Set(["codex", "kimi", "cursor"]);

export type ConfirmVerdict = { allow: true } | { allow: false; prompt: Prompt };

/** Cursor: how long the sibling pre-hook of the same Shell command may reuse a just-consumed token (see confirm-state.ts `ConsumeGrace`). */
const CURSOR_SIBLING_GRACE_MS = 10_000;

/**
 * Deny-message suffix while the G0 sub-agent freeze is on: a CONFIRM typed now
 * would be ignored silently by placeConfirmToken, so say so and until when.
 * @param sessionId - The session id.
 * @param now - Epoch ms.
 * @param home - Test-only OS home override.
 */
function frozenHint(sessionId: string, now: number, home?: string): string {
  const until = subagentFrozenUntil(sessionId, now, home);
  return until === null ? "" : `\nConfirmation frozen (sub-agent active) until ${new Date(until).toLocaleTimeString("en-GB")} — send the code again afterwards.`;
}

/**
 * Whether/how a CONFIRM token changes an `ask` prompt about to be downgraded
 * to a deny. Returns `null` when this mechanism doesn't apply AT ALL — any
 * harness other than codex/kimi/cursor, any prompt kind other than `ask`, no
 * command to key a hash off, or an irreversible command (G4) — in which case
 * the caller's ORIGINAL prompt/response path runs completely unchanged. The one
 * exception is an irreversible `rm` DELETE ask: it returns a code-less deny that
 * only adds the trash hint ({@link withTrashHint}). That
 * `null` fast-path, hit on every claude-code call and every non-`ask` prompt,
 * IS the non-regression property.
 * @param id - Harness target id.
 * @param prompt - The prompt `gate()` returned.
 * @param command - `event.command` for the tool-use under judgment.
 * @param sessionId - `event.sessionId`.
 * @param now - Epoch ms.
 * @param home - Test-only OS home override.
 * @param codex - Codex action context (Codex path only).
 * @param cursorGenerationId - Cursor `generation_id` (Cursor only): keys the sibling-pass grace.
 * @param cursorParentSessionId - Cursor sub-agent only: the parent chat session, whose token it may consume and where its pending deny is mirrored.
 */
export function confirmGate(
  id: string,
  prompt: Prompt,
  command: string | undefined,
  sessionId: string,
  now: number,
  home?: string,
  codex?: Readonly<{ tool: string; cwd: string; toolUseId?: string }>,
  cursorGenerationId?: string,
  cursorParentSessionId?: string,
): ConfirmVerdict | null {
  if (prompt.kind !== "ask" || !DEGRADES_ASK_TO_DENY.has(id) || !command) return null;
  // The rm DELETE ask also names the trash (`mv … ~/.Trash/`, always allowed); an irreversible one gets only that line, never a code.
  const hinted = withTrashHint(prompt, command);
  if (isIrreversible(command)) return hinted === prompt ? null : { allow: false, prompt: hinted };
  try {
    if (id === "codex" && codex) {
      const action = codexAction(codex.tool, codex.cwd, command, now);
      if (!action) return null;
      const verdict = authorizeCodexAction(sessionId, action, codex.toolUseId, now, home);
      if (verdict.allow) return verdict;
      const ruleId = prompt.ruleId ?? "policy:ask";
      const diagnostic = `rule ID: ${ruleId}\ncanonical command: ${action.command}\nexpected token: CONFIRM ${action.code}\nrejection: ${verdict.reason}`;
      return { allow: false, prompt: { ...prompt, reason: `${hinted.reason}\nTo allow, reply: CONFIRM ${action.code}\n${diagnostic}` } };
    }
    const hash = hashForAction(command);
    // Cursor runs this twice per Shell command (preToolUse + beforeShellExecution): let the sibling pass of the same turn reuse the token.
    const grace = id === "cursor" && cursorGenerationId ? { ms: CURSOR_SIBLING_GRACE_MS, generationId: cursorGenerationId } : undefined;
    if (consumeConfirmToken(sessionId, hash, now, home, grace)) return { allow: true };
    // Cursor sub-agent: the human confirms in the PARENT chat (cursor-subagent-link.ts).
    const parent = id === "cursor" ? cursorParentSessionId : undefined;
    if (parent && consumeConfirmToken(parent, hash, now, home, grace)) return { allow: true };
    const code = displayCodeForAction(command);
    recordPendingDeny(sessionId, hash, code, command, now, home);
    if (parent) recordPendingDeny(parent, hash, code, command, now, home);
    // A sub-agent's code is confirmed in the parent chat: show the exact command so the human sees what they approve.
    const shown = parent ? `\ncommand (sub-agent): ${command}` : "";
    return { allow: false, prompt: { ...prompt, reason: `${hinted.reason}\nTo allow, reply: CONFIRM ${code}${shown}${id === "cursor" ? frozenHint(parent ?? sessionId, now, home) : ""}` } };
  } catch {
    // A state-io failure (full disk, unwritable home) must fall back to the
    // plain deny, never crash the hook — same invariant as confirm-submit.ts.
    // The caller's `confirm ? confirm.prompt : prompt` treats `null` exactly
    // like "mechanism doesn't apply", i.e. the pre-CONFIRM deny unchanged.
    return null;
  }
}

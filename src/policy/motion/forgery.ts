/**
 * @module motion/forgery
 * The approval code is shown in the deny message, so an agent could replay the
 * exact `MOTION-APPROVE <stage> <code>` prompt through a channel that reaches
 * UserPromptSubmit without `agent_id` (a scheduled task, a nested `claude -p
 * --resume`). Refuse any tool call that carries the approval phrase on such a path.
 */
import type { Prompt } from "../../prompt/types";
import { expansionText } from "./shell-verbs";

const PHRASE = /MOTION-APPROVE/i;
/**
 * A typed confirmation (`CONFIRM ab12`, also `confirm_ab12` / `CONFIRM-ab12`): the same shape `typedConfirmCode` accepts,
 * where the code ENDS the argument (a closing quote or wrapper, a shell operator or comment, a newline, the end of the
 * command, or the next option). Prose such as `confirm face detection works` or `confirm 2025 deadline` is no code and
 * is not matched.
 */
const CONFIRM_PHRASE = /\bconfirm[ _-]*[0-9a-f]{4}(?=\s*(?:['"`*_»;&|)#<>]|$)|\s+-|[ \t]*\n)/i;
/** The agent CLIs an agent could launch to speak into another session. */
export const AGENT_CLI_VERBS: ReadonlySet<string> = new Set(["claude", "codex", "cursor-agent", "gemini", "kimi"]);
/** An agent CLI word at the start or after whitespace / a path slash. */
const AGENT_CLI = String.raw`(?:^|[\s/])(?:${[...AGENT_CLI_VERBS].join("|")})`;
/** An agent CLI followed by arguments. */
const AGENT_CLI_ARGS = new RegExp(`${AGENT_CLI}(?=\\s)`);
/** An agent CLI word, with or without arguments. */
const AGENT_CLI_WORD = new RegExp(`${AGENT_CLI}(?=\\s|$)`);
/** Tools that can queue a prompt for later or send one to a session. */
const DEFERRED_TOOL = /cron|schedule|wakeup|remotetrigger|sendmessage/i;

function block(detail: string): Prompt {
  return {
    kind: "block",
    title: "Motion approval forgery guard",
    reason: `Approvals come only from the owner typing MOTION-APPROVE <stage> <code> in their own session; an agent cannot relay that phrase (${detail}).`,
  };
}

/**
 * True when a Bash command carries a typed CONFIRM code through an agent CLI. The CONFIRM code (Codex/Kimi/Cursor rm and
 * git asks) is typed by the owner only: an agent CLI carrying it is a self-confirmation. A non-literal build of the
 * phrase (`"CONFIRM $(echo ab12)"`, `$'CONFIRM \x61b12'`) is refused the same way as a dynamic resumed prompt.
 * @param command - `tool_input.command` (Bash).
 */
export function relaysConfirm(command: string): boolean {
  if (!AGENT_CLI_WORD.test(command)) return false;
  const dynamic = /[$`<>]/.test(expansionText(command)) || /\$'/.test(command);
  return CONFIRM_PHRASE.test(command) || CONFIRM_PHRASE.test(expansionText(command))
    || (/\bconfirm/i.test(command) && (dynamic || /\\[xu0-7]/i.test(command)));
}

/**
 * Detect an agent attempt to inject the approval prompt from a non-human channel.
 * @param tool - Tool name.
 * @param command - `tool_input.command` (Bash).
 * @param input - Full `tool_input` object.
 * @param coreCoversConfirm - True when the core scope already refuses CONFIRM relays on this host (no duplicate deny).
 * @returns A block prompt, or `null` when the call does not carry the phrase on such a path.
 */
export function approvalForgeryViolation(tool: string, command: string | undefined, input: Record<string, unknown>, coreCoversConfirm = false): Prompt | null {
  if (tool === "Bash") {
    if (!command) return null;
    const agentCli = AGENT_CLI_ARGS.test(command);
    const resume = agentCli && /(?:^|\s)(?:--resume|--continue|--session|--last|-r|-c|-C|-S|resume)(?=\s|=|$)/.test(command);
    const dynamic = /[$`<>]/.test(expansionText(command)) || /\$'/.test(command);
    const confirm = !coreCoversConfirm && relaysConfirm(command);
    return PHRASE.test(command) || PHRASE.test(expansionText(command)) || confirm || (resume && dynamic)
      ? block("Bash approval phrase or non-literal resumed session prompt") : null;
  }
  if (!DEFERRED_TOOL.test(tool)) return null;
  let text = "";
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    return block(`${tool} with an unserializable input`);
  }
  return PHRASE.test(text) ? block(`${tool} carrying the approval phrase`) : null;
}

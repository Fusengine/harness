import { briefText, isBriefCall, ownerRulesQuotes } from "../../policy/lead-guards/owner-rules";
import { HELPER_AGENT_TYPES, LEAD_GUARD_ENV, SCOPE_BLOCK_REASON } from "../../policy/lead-guards/markers";
import type { Prompt } from "../../prompt/types";
import { quoteInOwnerMessages } from "./transcript-owner";

/** True for the lead's own workflow helpers (see {@link HELPER_AGENT_TYPES}); matches with or without a `plugin:` prefix. */
function isHelperAgent(subagentType: unknown): boolean {
  return typeof subagentType === "string" && HELPER_AGENT_TYPES.has(subagentType.slice(subagentType.lastIndexOf(":") + 1));
}

/**
 * Lead scope guard (PreToolUse on Agent/Task/SendMessage): a task brief must carry an OWNER RULES
 * section with at least one quote that appears verbatim in a real owner message of this session.
 * Applies to the Claude Code lead only (no `agent_id`), unless `FUSE_LEAD_SCOPE_GUARD=0`. A brief with
 * no quote at all is denied without reading the transcript; an unreadable / absent transcript lets the
 * call through (fail-open: the guard never blocks on missing evidence it cannot read).
 * @param tool - Normalized tool name.
 * @param input - The tool input.
 * @param payload - The raw hook payload.
 * @param id - Harness adapter id.
 * @param env - Environment (injectable for tests).
 * @returns A block prompt, or `null` to let the call through.
 */
export function leadScopeGate(
  tool: string,
  input: Record<string, unknown>,
  payload: Record<string, unknown>,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Prompt | null {
  if (id !== "claude-code" || env[LEAD_GUARD_ENV.scope] === "0" || typeof payload.agent_id === "string") return null;
  const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  if (!transcript) return null; // Claude Code always sends it; without it nothing can be verified, so never deny.
  const brief = briefText(tool, input);
  if (!isBriefCall(tool, brief) || isHelperAgent(input.subagent_type)) return null;
  const deny = (): Prompt => ({ kind: "block", ruleId: "lead-scope-guard", title: "Brief without the owner's words", reason: SCOPE_BLOCK_REASON });
  const quotes = ownerRulesQuotes(brief);
  if (quotes.length === 0) return deny();
  return quoteInOwnerMessages(transcript, quotes) === false ? deny() : null;
}

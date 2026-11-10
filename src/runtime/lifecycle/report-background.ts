/**
 * @module report-background
 * Report recovery for BACKGROUND sub-agents. Their final result reaches the parent as a queued
 * user turn (`<task-notification>`), on which the `UserPromptSubmit` hook fires. Shape captured
 * from a real lead session (CC 2.1.317-319): `<task-notification>\n<task-id>ID</task-id>…<result>…</result>…</task-notification>`
 * where `ID` is the sub-agent's `agentId`, i.e. the `agent-ID.jsonl` transcript name.
 *
 * Guarantees: keyed on the guard emission recorded for `ID` in this session (never on text resemblance);
 * APPENDED after everything the turn already injects (nothing displaced, reordered or shrunk) and only within
 * the hook output cap; every `<task-notification>` block of the prompt is handled; a block is injected once
 * (fingerprint per record); the record is NOT consumed, so a typed or quoted look-alike cannot steal the real
 * notification (a typed look-alike can surface that same session's sub-agent report: accepted, same-session data).
 * Shape confirmed on a live `claude -p` (CC 2.1.319) background run: `<task-id>` equals the SubagentStop `agent_id`.
 */
import { homedir } from "node:os";
import { sanitizeSessionId } from "../home-state";
import { isAgentKey } from "./agent-files";
import { limitNotice, recoverReport } from "./report-recovery";
import { loadRecord, saveRecord } from "./report-record";
import { sha } from "./report-transcript";

/** Claude Code's per-field `additionalContext` cap: above it the whole field is spilled to a file. */
export const HOOK_OUTPUT_CAP = 10_000;
/** Separator between the existing context and the recovered text. */
const SEP = "\n\n";
/** One whole notification block, anywhere in the prompt; captures the task id. */
const BLOCK_RE = /<task-notification>\s*<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>[\s\S]*?<\/task-notification>/g;

/** The block's `<result>…</result>` body (what the parent was handed), or `""`. */
function resultOf(block: string): string {
  const start = block.indexOf("<result>");
  if (start === -1) return "";
  const end = block.lastIndexOf("</result>");
  return block.slice(start + "<result>".length, end > start ? end : undefined);
}

/**
 * The recovered text for every notification block of a prompt, within `budget` chars.
 * @param payload - The UserPromptSubmit payload (`session_id`).
 * @param prompt - The normalized prompt text.
 * @param budget - Max chars of the whole returned text.
 * @param home - Home dir.
 * @returns The texts joined by a blank line, or `""`. Never throws.
 */
export function recoveredBackgroundText(payload: Record<string, unknown>, prompt: string, budget: number, home: string = homedir()): string {
  try {
    const sid = sanitizeSessionId(payload.session_id);
    if (!sid || !prompt.includes("<task-notification>")) return "";
    const out: string[] = [];
    let left = budget;
    for (const m of prompt.matchAll(BLOCK_RE)) {
      const agentId = m[1];
      const rec = isAgentKey(agentId) ? loadRecord(sid, agentId, home) : null;
      if (!rec) continue;
      const fp = sha(m[0]);
      if (rec.delivered?.includes(fp)) continue; // double delivery: once
      let text = recoverReport(rec, resultOf(m[0]), left);
      if (text.length > left) {
        // No room even for the truncated form: a minimal pointer if THAT fits, else nothing (later turn); never a partial report.
        const pointer = limitNotice(rec);
        if (!pointer || pointer.length > left) continue;
        text = pointer;
      }
      if (text) { out.push(text); left -= text.length + SEP.length; }
      try { saveRecord(sid, home, { ...rec, delivered: [...(rec.delivered ?? []), fp] }); } catch { /* best effort */ }
    }
    return out.join(SEP);
  } catch {
    return "";
  }
}

/**
 * Append the recovered background reports AFTER the context a UserPromptSubmit already carries.
 * The existing stdout is returned unchanged when there is nothing to add.
 * @param baseStdout - The final hook stdout of the turn (`""` allowed).
 * @param payload - The UserPromptSubmit payload.
 * @param prompt - The normalized prompt text.
 * @param home - Home dir.
 * @returns The stdout, with the recovered text appended after the existing `additionalContext`.
 */
export function withBackgroundReports(baseStdout: string, payload: Record<string, unknown>, prompt: string, home: string = homedir()): string {
  let parsed: { hookSpecificOutput?: Record<string, unknown> } = {};
  try { if (baseStdout) parsed = JSON.parse(baseStdout) as typeof parsed; } catch { return baseStdout; }
  if (!parsed || typeof parsed !== "object") return baseStdout;
  const hso = parsed.hookSpecificOutput ?? {};
  const ctx = typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  const text = recoveredBackgroundText(payload, prompt, HOOK_OUTPUT_CAP - (ctx ? ctx.length + SEP.length : 0), home);
  if (!text) return baseStdout;
  return JSON.stringify({ ...parsed, hookSpecificOutput: { hookEventName: "UserPromptSubmit", ...hso, additionalContext: ctx ? `${ctx}${SEP}${text}` : text } });
}

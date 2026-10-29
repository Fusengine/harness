/**
 * Visible acknowledgement for a typed `CONFIRM <code>` at the root prompt
 * (mandate: never swallow a code silently again). Only hosts with a VERIFIED
 * UserPromptSubmit feedback channel are served:
 * - kimi: raw stdout text (appended to context on exit 0 — runtime/inform.ts);
 * - codex: the Claude-shaped `additionalContext` envelope (its `systemMessage`
 *   never reaches the user — confirm-code.ts); merged INTO the existing
 *   envelope so stdout stays a single JSON payload.
 * Cursor (`user_message` would need adapters/cursor/respond.ts, out of scope),
 * claude-code (native interactive ask — CONFIRM never applies), gemini-cli,
 * cline and hermes (no verified UPS channel): NO emission, byte-identical.
 */
import { listPendingDenies } from "./confirm-pending";
import { listCodexPendingDenies } from "./codex-confirm";
import { contextResponse } from "../../adapters/claude";
import type { ConfirmSubmitOutcome } from "./confirm-outcome";

/** Hosts with a verified UserPromptSubmit feedback channel. */
const FEEDBACK_HOSTS: ReadonlySet<string> = new Set(["kimi", "codex"]);

/** One line of the "codes en attente" footer: a display code + its command. */
export interface ConfirmPendingLine {
  code: string;
  command: string;
}

/** Whether this harness gets a visible CONFIRM acknowledgement at all. */
export function supportsConfirmFeedback(id: string): boolean {
  return FEEDBACK_HOSTS.has(id);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Render a stored command on ONE line: every control char (U+0000–U+001F,
 * U+007F–U+009F, incl. NEL U+0085) and U+2028/U+2029 becomes a visible escape (`\n`, `\r`, `\t`, else
 * `\uXXXX`), so a crafted command can never forge a second ack line. A command
 * without such characters is returned unchanged. Built from char codes: a
 * literal U+2028/U+2029 in a regex source would end the line.
 * @param command - The stored command.
 */
export function oneLineCommand(command: string): string {
  let out = "";
  for (const c of command) {
    const n = c.charCodeAt(0);
    if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029) out += `\\u${n.toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return out;
}

/**
 * Render the feedback line for one CONFIRM outcome. "" for a refusal (silent,
 * as before) — every other outcome names the code and, when relevant, the
 * command it armed or the codes still pending.
 */
export function confirmFeedbackText(outcome: ConfirmSubmitOutcome, pendings: readonly ConfirmPendingLine[]): string {
  switch (outcome.kind) {
    case "armed":
      // Codex asks the agent to rerun NOW (the 2026-10-29 incident: it never reran inside the TTL).
      // The full command is shown untruncated but on one line (control chars escaped, see oneLineCommand).
      if (outcome.rerun) return `[fuse-harness] CONFIRM ${outcome.code} accepté — relance maintenant exactement : ${oneLineCommand(outcome.command) || "(commande non enregistrée)"} (valide 5 min)`;
      return `[fuse-harness] CONFIRM ${outcome.code} accepté pour : ${truncate(outcome.command || "(commande non enregistrée)", 60)} (valable 5 min)`;
    case "already-consumed":
      return `[fuse-harness] CONFIRM ${outcome.code} déjà utilisé : l'action a déjà été exécutée — si elle est de nouveau refusée, un nouveau code sera donné.`;
    case "unknown-code": {
      const list = pendings.map((p) => `${p.code} (${truncate(p.command || "(commande non enregistrée)", 40)})`).join(" · ");
      return `[fuse-harness] CONFIRM ${outcome.code} inconnu — codes en attente : ${list || "aucun"}`;
    }
    case "frozen":
      return `[fuse-harness] CONFIRM ${outcome.code} gelé : un sous-agent est actif (G0) — renvoie le code après.`;
    case "refused":
      return "";
  }
}

/** The session's pending codes for the feedback footer, read from the firing host's OWN store. */
export function confirmPendingLines(id: string, sessionId: string, now: number, home?: string): ConfirmPendingLine[] {
  if (id === "codex") return listCodexPendingDenies(sessionId, now, home).map((a) => ({ code: a.code, command: a.command }));
  return listPendingDenies(sessionId, now, home).map((p) => ({ code: p.code, command: p.command }));
}

/**
 * Merge the feedback line into the UserPromptSubmit stdout. Byte-identical
 * passthrough when there is no feedback or the host has no channel. Kimi:
 * prepended raw text. Codex: merged into the existing envelope's
 * `additionalContext` (or a fresh envelope when the pipeline emitted nothing).
 */
export function mergeConfirmFeedback(id: string, feedbackText: string, baseStdout: string): string {
  if (!feedbackText || !supportsConfirmFeedback(id)) return baseStdout;
  if (id === "kimi") return baseStdout ? `${feedbackText}\n\n${baseStdout}` : feedbackText;
  if (!baseStdout) return contextResponse("UserPromptSubmit", feedbackText);
  try {
    const parsed = JSON.parse(baseStdout) as Record<string, unknown>;
    const hso = parsed.hookSpecificOutput as { additionalContext?: unknown } | undefined;
    if (typeof hso?.additionalContext !== "string") return baseStdout;
    return JSON.stringify({ ...parsed, hookSpecificOutput: { ...hso, additionalContext: `${feedbackText}\n\n${hso.additionalContext}` } });
  } catch {
    return baseStdout;
  }
}

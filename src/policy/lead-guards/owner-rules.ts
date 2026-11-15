import type { ScopeVerdict } from "./interfaces/types";
import {
  BRIEF_HEADERS,
  MIN_QUOTE_CHARS,
  NEXT_HEADER_RE,
  OWNER_HEADER_RE,
  OWNER_SECTION_MAX_CHARS,
  QUOTE_RE,
  SCOPE_BLOCK_REASON,
  SENDMESSAGE_BRIEF_MIN_HEADERS,
} from "./markers";

/**
 * Collapse every whitespace run to one space and trim.
 * @param s - Any text.
 * @returns The normalized text.
 */
export function normalizeWs(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Quotes (« », “ ”, " ", „ “, 「 」, 『 』, ‹ ›) of the OWNER RULES section of a brief: from the header to the next fixed header
 * (or {@link OWNER_SECTION_MAX_CHARS}), whitespace-normalized, shorter than {@link MIN_QUOTE_CHARS} dropped.
 * @param brief - The brief text.
 * @returns The normalized quotes ([] when there is no OWNER RULES section).
 */
export function ownerRulesQuotes(brief: string): string[] {
  const header = OWNER_HEADER_RE.exec(brief);
  if (!header) return [];
  const rest = brief.slice(header.index + header[0].length, header.index + OWNER_SECTION_MAX_CHARS);
  const end = rest.search(NEXT_HEADER_RE);
  const section = end < 0 ? rest : rest.slice(0, end);
  const quotes: string[] = [];
  for (const m of section.matchAll(QUOTE_RE)) {
    const q = normalizeWs(m.slice(1).find((g) => g !== undefined) ?? "");
    if ([...q].length >= MIN_QUOTE_CHARS) quotes.push(q);
  }
  return quotes;
}

/** Number of distinct fixed brief headers (`WRITE:`, `PROOF`, ...) present in `text`. */
function headerCount(text: string): number {
  return BRIEF_HEADERS.filter((h) => new RegExp(String.raw`(?:^|[\s*#_])${h.replace("-", "\\-")}(?=\s*[:(\n]|\s*$)`, "m").test(text)).length;
}

/**
 * True when this lead tool call dispatches a task: `Agent`/`Task` always; `SendMessage` only when the
 * message carries at least {@link SENDMESSAGE_BRIEF_MIN_HEADERS} fixed brief headers (a one-line
 * follow-up inside an already-briefed mandate is not a brief).
 * @param tool - Normalized tool name.
 * @param text - The prompt/message text.
 * @returns True when the call is a task brief subject to the scope guard.
 */
export function isBriefCall(tool: string, text: string): boolean {
  if (tool === "Agent" || tool === "Task") return true;
  return tool === "SendMessage" && headerCount(text) >= SENDMESSAGE_BRIEF_MIN_HEADERS;
}

/**
 * The brief text of a tool input: `prompt` for Agent/Task, `message` for SendMessage ("" when not a string).
 * @param tool - Normalized tool name.
 * @param input - The tool input object.
 * @returns The brief text, or "".
 */
export function briefText(tool: string, input: Record<string, unknown>): string {
  const v = tool === "SendMessage" ? input.message : input.prompt;
  return typeof v === "string" ? v : "";
}

/**
 * Scope traceability: the brief passes when at least one quote of its OWNER RULES section appears
 * verbatim (whitespace-normalized, case-sensitive) inside one real owner message.
 * @param brief - The brief text.
 * @param ownerMessages - Whitespace-normalized texts of the real owner messages of the session.
 * @returns `ok`, or a one-line instruction.
 */
export function checkBrief(brief: string, ownerMessages: readonly string[]): ScopeVerdict {
  const quotes = ownerRulesQuotes(brief);
  const found = quotes.some((q) => ownerMessages.some((m) => m.includes(q)));
  return found ? { ok: true, reason: "" } : { ok: false, reason: SCOPE_BLOCK_REASON };
}

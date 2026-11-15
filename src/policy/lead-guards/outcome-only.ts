import type { OutcomeVerdict } from "./interfaces/types";
import {
  ANCHOR_TARGET_RE,
  CODE_SPAN_RE,
  FENCED_BLOCK_RE,
  LIST_ITEM_RE,
  OUTCOME_MARKERS,
  OWNER_ACTION_MARKERS,
  RELAY_MAX_CHARS,
  RELAY_MIN_CHARS,
  REPORT_MIN_CHARS,
  REPORT_MIN_LIST_ITEMS,
  REPORT_MIN_SENTENCES,
  SENTENCE_END_RE,
} from "./markers";

/** Number of matches of the global regex `re` in `text`. */
function count(re: RegExp, text: string): number {
  return [...text.matchAll(re)].length;
}

/**
 * Classify the final assistant message of a turn by STRUCTURE only (no word of any language is read).
 * `markers` lists every structural outcome marker (URL outside code, commit hash, PR number, file path,
 * ratio, percentage / unit, exit code, version / tag, table, check symbol, figures) and owner action (a question
 * mark of any script, `trailing-semicolon`: a line ending in `;` / U+037E, a fenced block, a quoted phrase)
 * found, plus report shape (`list`: 2+ bullet lines, `multi-sentence`: 4+ sentences, `long-body`:
 * {@link REPORT_MIN_CHARS}+ characters of prose outside code spans and fenced blocks), which only ever lets a message
 * through. A message over 4 x {@link RELAY_MAX_CHARS} is not scanned (`long-message`). `statusOnly` = none at all. `relayLike` = status-only AND
 * between {@link RELAY_MIN_CHARS} and {@link RELAY_MAX_CHARS} code units: the only shape the Stop guard blocks.
 * @param text - The final assistant message.
 * @returns The verdict.
 */
export function classifyFinalMessage(text: string): OutcomeVerdict {
  // Beyond the relay bound a message can never be blocked: skip the scan (also keeps the regexes off adversarial 100 KB inputs).
  if (text.length > RELAY_MAX_CHARS * 4) return { statusOnly: false, markers: ["long-message"], relayLike: false };
  const body = text.replace(ANCHOR_TARGET_RE, "]");
  const prose = body.replace(FENCED_BLOCK_RE, " ");
  const bare = prose.replace(CODE_SPAN_RE, " ");
  const markers = [
    ...OUTCOME_MARKERS.filter((m) => m.re.test(m.outsideCode ? bare : body)).map((m) => m.name),
    ...OWNER_ACTION_MARKERS.filter((m) => m.re.test(body)).map((m) => m.name),
    ...(count(LIST_ITEM_RE, body) >= REPORT_MIN_LIST_ITEMS ? ["list"] : []),
    ...(count(SENTENCE_END_RE, body) >= REPORT_MIN_SENTENCES ? ["multi-sentence"] : []),
    ...(bare.trim().length >= REPORT_MIN_CHARS ? ["long-body"] : []),
  ];
  const statusOnly = markers.length === 0;
  const length = body.trim().length;
  return { statusOnly, markers, relayLike: statusOnly && length >= RELAY_MIN_CHARS && length <= RELAY_MAX_CHARS };
}

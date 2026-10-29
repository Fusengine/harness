/**
 * Parse the 4-hex code of a typed `CONFIRM <code>` at the Codex root prompt.
 * Pure module — no state, no I/O — so the parsing contract is differential-testable.
 */

/** Base anchor, unchanged since the original codex path: the WHOLE (trimmed) message is `CONFIRM xxxx`. */
const CONFIRM_WHOLE_RE = /^confirm[ _-]*([0-9a-f]{4})$/i;

/**
 * Wrapper pairs (markdown emphasis / code span / quotes) a chat UI leaves
 * around a copied code. ONE matched pair around the WHOLE message is removed,
 * never anything inside it, never nested (`***x***` stays unmatched).
 */
const WRAPPER_PAIRS: readonly (readonly [string, string])[] = [
  ["**", "**"], ["__", "__"], ["*", "*"], ["_", "_"], ["`", "`"], ['"', '"'], ["'", "'"], ["«", "»"],
];

/**
 * The typed 4-hex code if the whole trimmed message is `CONFIRM xxxx`, either
 * bare or wrapped in exactly one matched pair from {@link WRAPPER_PAIRS}.
 * Anything else (extra words, newlines, unbalanced/nested wrappers, lookalike
 * characters, 5 hex chars) yields `undefined`, exactly as the bare-only regex.
 * @param text - The prompt text.
 */
export function typedConfirmCode(text: string): string | undefined {
  const t = text.trim();
  const bare = t.match(CONFIRM_WHOLE_RE)?.[1];
  if (bare) return bare;
  for (const [open, close] of WRAPPER_PAIRS) {
    if (t.length <= open.length + close.length || !t.startsWith(open) || !t.endsWith(close)) continue;
    const code = t.slice(open.length, t.length - close.length).match(CONFIRM_WHOLE_RE)?.[1];
    if (code) return code;
  }
  return undefined;
}

/**
 * @module motion/sensitive
 * Sensitive-data scan of content written under the motion source dir: the
 * user-level banned list (`~/.fuse-harness/motion/banned.txt`, one term per
 * line, case-insensitive; absent = no terms — it lives in the OS home, never
 * in a git repo) and currency amounts. A hit is reported REDACTED: the term
 * itself never travels back into the agent's context.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripProgramBodies } from "./program-bodies";
import { fuseHarnessHome } from "../../runtime/home-state";
import { motionHome } from "./store";

/** Currency amount: `12 €`, `1 299,50 EUR`, `$1,299.00`, `£ 40`. Horizontal spaces only (incl. NBSP / narrow NBSP). */
const CURRENCY_RE = /\b\d[\d \t  .,]{0,24}[ \t  ]?(?:[$€£]|(?:USD|EUR|GBP)\b)|[$€£][ \t  ]?\d/i;

/** Replacement references and positional parameters on recognizable shell-command lines are not prices. */
const REPLACE_LINE_RE = /(?:\breplace(?:All)?\s*\(|\.sub\()/;
const SHELL_LINE_RE = /(?:^|[;|&]\s*)\s*(?:echo|printf|awk|gawk|mawk|sh|bash|zsh|exec|export)\b/;

/**
 * Line rules unchanged since dd8a2e1; the only extension is {@link stripProgramBodies},
 * which strips field references in code position inside single-quoted awk/gawk/mawk bodies
 * opened AND closed by a quote in the same source. Template literals never qualify:
 * `` `${a}$1` `` has the same shape as the real price `` `${cur}$5` ``, so both stay blocked.
 */
const stripBackrefs = (text: string): string =>
  stripProgramBodies(text).split("\n").map((line) => {
    // A standalone positional token is code, not a price declaration; a literal integer dollar price is ambiguous.
    if (/^\s*\$(?:\d|\{\d+\})\s*$/.test(line)) return "";
    if (REPLACE_LINE_RE.test(line)) return line.replace(/\$\d(?![\d.,])/g, "");
    return SHELL_LINE_RE.test(line) ? line.replace(/\$\{\d+\}|\$\d(?![\d.,])/g, "") : line;
  }).join("\n");

/** Path of the user-level banned list. */
export function bannedListPath(home: string = homedir()): string {
  return join(motionHome(home), "banned.txt");
}

/** Banned terms (trimmed, non-empty, `#` comments skipped); `[]` when the file is absent/unreadable. */
export function loadBannedTerms(home: string = homedir()): string[] {
  // Union of the new list and a not-yet-migrated pre-relocation list: terms are never silently dropped.
  const terms = new Set(readTerms(bannedListPath(home)));
  for (const term of readTerms(join(fuseHarnessHome(home), "motion", "banned.txt"))) terms.add(term);
  return [...terms];
}

/** Terms of one banned list file; `[]` when absent/unreadable. */
function readTerms(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Redacted form of a term: first char + one `*` per remaining char (e.g. `A****`); terms of 1-2 chars are fully masked. */
export function redact(term: string): string {
  const chars = [...term];
  if (chars.length <= 2) return "*".repeat(chars.length);
  return `${chars[0] ?? ""}${"*".repeat(chars.length - 1)}`;
}

/**
 * First sensitive hit in the complete `content`, already redacted.
 * @param content - Written content (Write `content` / Edit `new_string`).
 * @param terms - Banned terms ({@link loadBannedTerms}).
 * @returns A redacted hit, or `null` when clean regardless of content length.
 */
export function findSensitive(content: string, terms: string[]): string | null {
  const text = content.normalize("NFC").toLocaleLowerCase();
  for (const term of terms) {
    if (text.includes(term.normalize("NFC").toLocaleLowerCase())) return `banned term "${redact(term)}"`;
  }
  const m = stripBackrefs(content).match(CURRENCY_RE);
  return m ? `currency amount "${redact(m[0].trim())}"` : null;
}

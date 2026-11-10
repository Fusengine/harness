/**
 * @module security/scan-patterns
 * Compatibility shim: the rule tables moved to `scan/patterns/`. Kept so the
 * historical import path and `getPatterns(lang)` keep working.
 * @packageDocumentation
 */
import { SOURCE_LANGUAGE_IDS, type SourceLanguageId } from "../../../util/source-languages";
import { patternsFor } from "./scan/patterns";
import type { ScanPattern } from "./scan/types";

export type { ScanPattern, Severity } from "./scan/types";

/**
 * Return the rules for a language id (`javascript`, `php`, `python`, `swift`, `go`,
 * `rust`, ...). Unknown languages yield only the language-agnostic secret rules.
 * @param lang - language id (see `util/source-languages`)
 */
export function getPatterns(lang: string): ScanPattern[] {
  const known = (SOURCE_LANGUAGE_IDS as readonly string[]).includes(lang);
  return patternsFor(known ? (lang as SourceLanguageId) : "text");
}

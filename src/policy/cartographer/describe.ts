/**
 * File-description heuristics — pure text in, description out (no fs). Ports
 * `describe.py`; source-file comments are handled per language family
 * (`comment-families`, `comment-syntax`).
 */
import { languageOfExtension } from "../../util/source-languages";
import { COMMENT_SYNTAX, LEGACY_SUFFIXES, LEGACY_SYNTAX } from "./comment-families";
import { describeSource, firstBlockComment, firstLineComment } from "./comment-syntax";

/**
 * First `# ` Markdown heading text (sans hashes), sliced to 60. "" when none.
 * @param text - The document text.
 * @returns The heading text, or "".
 */
export function firstHeading(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) return line.replace(/^#+/, "").trim().slice(0, 60);
  }
  return "";
}

/**
 * First leading comment among the first 10 lines (`//`, `#` but not `#!`, or a
 * `"""`/`'''` docstring), sliced to 60. "" when none. Legacy generic form;
 * per-language logic is {@link descFromText}. Reuses the legacy family
 * (`//` + `#` + docstrings), exactly the python entry of {@link COMMENT_SYNTAX}.
 * @param text - The source text.
 * @returns The comment text, or "".
 */
export function firstComment(text: string): string {
  return firstLineComment(text, LEGACY_SYNTAX);
}

/**
 * Whether a file with this suffix can have a description at all (`.md` or a
 * known source language). Callers use it to skip reading everything else.
 * @param suffix - The file extension (with dot).
 * @returns True when {@link descFromText} may return a non-empty value.
 */
export function isDescribableSuffix(suffix: string): boolean {
  return suffix === ".md" || languageOfExtension(suffix) !== undefined;
}

/**
 * Derive a description from a file's suffix + text. For `.md`, the supplied
 * frontmatter `description` (truncated) wins over the first heading; for known
 * source languages, the first leading comment in that language's syntax; else "".
 * @param suffix - The file extension (with dot).
 * @param text - The file text.
 * @param mdField - The pre-parsed frontmatter `description` (md only).
 * @returns The derived description, or "".
 */
export function descFromText(suffix: string, text: string, mdField: string): string {
  if (suffix === ".md") return mdField.slice(0, 60) || firstHeading(text);
  const language = languageOfExtension(suffix);
  if (!language) return "";
  const syntax = COMMENT_SYNTAX[language];
  // Historical extensions keep their exact line-comment pass; everything new is filtered.
  if (LEGACY_SUFFIXES.has(suffix)) return firstLineComment(text, LEGACY_SYNTAX) || firstBlockComment(text, syntax);
  return describeSource(text, syntax);
}

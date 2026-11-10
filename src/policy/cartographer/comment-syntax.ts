/**
 * Leading-comment extraction driven by a {@link CommentSyntax} (pure text, no
 * fs). Both passes only look at the first {@link HEAD_LINES} lines.
 */
import type { CommentSyntax } from "./comment-families";

const HEAD_LINES = 10;
const MAX_DESC = 60;
/** Start of a license/copyright header: the whole comment run or block it opens is skipped. */
const LICENSE = /^(?:copyright\b|\(c\)|©|licen[sc]ed?\b|this file is part of\b|permission is hereby|all rights reserved)/i;
/** Tool directives and one-line license ids: only that line is skipped. */
const DIRECTIVE =
  /^(?:eslint|istanbul|prettier|jshint|jslint|tslint|globals?\b|@ts-|ts-(?:check|nocheck|ignore|expect-error)|@flow|swiftlint|swiftformat|noqa|pylint|nolint|nosec|noinspection|spdx-license-identifier|go:|\+build|-\*-|vim?:)/i;

/** A comment line is prose only if it holds a letter or digit (not `=====`, `-----`, `*****`, `####`). */
const PROSE = /[\p{L}\p{N}]/u;

/** Comment text without its markers, e.g. `// x` -> `x`. */
function stripLine(line: string): string {
  return line.replace(/^[/#! ]+/, "");
}

/** Whether a line is a line comment of `syntax` (shebangs never are). */
function isLineComment(line: string, syntax: CommentSyntax): boolean {
  return syntax.line.some((tok) => line.startsWith(tok)) && !line.startsWith("#!");
}

/**
 * First line comment (or docstring) among the first 10 lines, sliced to 60.
 * `#!` shebangs are never comments. With `syntax.filter`, license headers
 * (the whole contiguous comment run) and tool directives are skipped and empty
 * comment lines ignored; without it the first marker line wins as-is. "" when none.
 * @param text - The source text.
 * @param syntax - The language's comment syntax.
 * @returns The comment text, or "".
 */
export function firstLineComment(text: string, syntax: CommentSyntax): string {
  let inLicense = false;
  for (const raw of text.split("\n").slice(0, HEAD_LINES)) {
    const line = raw.trim();
    const lineComment = isLineComment(line, syntax);
    if (inLicense && lineComment) continue;
    inLicense = false;
    if (syntax.skip?.test(line)) continue;
    const doc = syntax.docstring && (line.startsWith('"""') || line.startsWith("'''"));
    if (!lineComment && !doc) continue;
    const body = lineComment ? stripLine(line) : line.replace(/^['"\s]+|['"\s]+$/g, "");
    if (syntax.filter) {
      if (!PROSE.test(body) || DIRECTIVE.test(body) || syntax.skip?.test(body)) continue;
      if (LICENSE.test(body)) {
        inLicense = true;
        continue;
      }
    }
    return body.slice(0, MAX_DESC);
  }
  return "";
}

/**
 * First prose line of the first block comment opening within the first 10
 * lines (single-line block, doc-block opener followed by ` * x` lines, or an
 * HTML comment), sliced to 60. Blocks that open with a license header or a
 * directive are skipped whole. "" when none.
 * @param text - The source text.
 * @param syntax - The language's comment syntax.
 * @returns The comment text, or "".
 */
export function firstBlockComment(text: string, syntax: CommentSyntax): string {
  const lines = text.split("\n").slice(0, HEAD_LINES).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const delim = syntax.blocks.find(([open]) => lines[i]?.startsWith(open));
    if (!delim) continue;
    let prose = "";
    let j = i;
    for (; j < lines.length; j++) {
      const seg = j === i ? (lines[i] ?? "").slice(delim[0].length) : (lines[j] ?? "");
      const end = seg.indexOf(delim[1]);
      const body = (end >= 0 ? seg.slice(0, end) : seg).replace(/^[\s*!]+/, "").trimEnd();
      // `@tag` lines (JSDoc/KDoc) carry no prose: the description is the first prose line.
      if (!prose && PROSE.test(body) && !body.startsWith("@") && !syntax.skip?.test(body)) {
        if (!DIRECTIVE.test(body) && !LICENSE.test(body)) return body.slice(0, MAX_DESC);
        prose = body;
      }
      if (end >= 0) break;
    }
    i = j;
  }
  return "";
}

/**
 * Description of a source file: its first line comment, else its first block
 * comment (so existing line-comment descriptions never change).
 * @param text - The source text.
 * @param syntax - The language's comment syntax.
 * @returns The description, or "".
 */
export function describeSource(text: string, syntax: CommentSyntax): string {
  return firstLineComment(text, syntax) || firstBlockComment(text, syntax);
}

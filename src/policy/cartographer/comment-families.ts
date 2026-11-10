/**
 * Comment-syntax families for the cartographer, keyed by {@link SourceLanguageId}
 * (the single extension table lives in `util/source-languages`; nothing here
 * maps extensions to languages). Pure data — the matching algorithm is in
 * `comment-syntax`.
 */
import type { SourceLanguageId } from "../../util/source-languages";

/** A block-comment delimiter pair. */
export type BlockDelimiters = readonly [open: string, close: string];

/** How a language writes the leading comment the cartographer describes a file by. */
export interface CommentSyntax {
  /** Line-comment openers (`//`, `#`); `///` and `//!` are covered by `//`. */
  readonly line: readonly string[];
  /** Whether a leading `"""` / `'''` docstring counts as a comment. */
  readonly docstring: boolean;
  /** Block-comment delimiters, tried only when no line comment matched. */
  readonly blocks: readonly BlockDelimiters[];
  /** Skip license headers and tool directives (eslint, istanbul, ...) and keep looking for prose. */
  readonly filter: boolean;
  /** A trimmed line (or block-comment text) matching this is never a description. */
  readonly skip?: RegExp;
}

const C_BLOCK: BlockDelimiters = ["/*", "*/"];
const HTML_BLOCK: BlockDelimiters = ["<!--", "-->"];

/**
 * Line-comment syntax of the 6 historical extensions ({@link LEGACY_SUFFIXES}):
 * `//` and `#` both count, plus docstrings, unfiltered — kept so their existing
 * descriptions stay byte-identical (including known quirks such as a
 * `Copyright` header or a JS `#private` field read as a comment).
 */
export const LEGACY_SYNTAX: CommentSyntax = { line: ["//", "#"], docstring: true, blocks: [], filter: false };

/** The extensions that predate the language families; only their line pass uses {@link LEGACY_SYNTAX}. */
export const LEGACY_SUFFIXES: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".swift"]);

/** C-style languages: `//` (also `///`, `//!`) and slash-star block comments (also doc blocks). */
const C_STYLE: CommentSyntax = { line: ["//"], docstring: false, blocks: [C_BLOCK], filter: true };

/**
 * Comment syntax per language id, used for every new extension and for the
 * block-comment fallback of all (exhaustive: a new id must be classified here).
 */
export const COMMENT_SYNTAX: Readonly<Record<SourceLanguageId, CommentSyntax>> = {
  javascript: C_STYLE,
  typescript: C_STYLE,
  swift: C_STYLE,
  python: { line: ["#"], docstring: true, blocks: [], filter: true },
  vue: { ...C_STYLE, blocks: [C_BLOCK, HTML_BLOCK] },
  svelte: { ...C_STYLE, blocks: [C_BLOCK, HTML_BLOCK] },
  astro: { ...C_STYLE, blocks: [C_BLOCK, HTML_BLOCK] },
  java: C_STYLE,
  kotlin: C_STYLE,
  rust: C_STYLE,
  go: C_STYLE,
  csharp: { ...C_STYLE, skip: /^\/\/\/\s*<\/?\w[^>]*>\s*$/ },
  php: { ...C_STYLE, line: ["//", "#"], skip: /^#\[/ },
  ruby: {
    line: ["#"],
    docstring: false,
    blocks: [],
    filter: true,
    skip: /^#\s*(frozen_string_literal|encoding|coding|typed|warn_indent|-\*-)/,
  },
};

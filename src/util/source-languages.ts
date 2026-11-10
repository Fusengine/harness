/**
 * @module util/source-languages
 * Single, scanner-agnostic table mapping source-file extensions to stable
 * language ids. Pure data plus a tiny lookup: consumers (security scanner,
 * cartographer comment syntax, ...) key their own data by {@link SourceLanguageId}.
 * Language ids are a stable contract: never rename one, only add.
 * @packageDocumentation
 */

/** Stable language ids (lower-case). Add new ids; never rename existing ones. */
export type SourceLanguageId =
  | "javascript" | "typescript" | "vue" | "svelte" | "astro" | "php" | "python"
  | "swift" | "go" | "rust" | "ruby" | "java" | "kotlin" | "csharp";

/** Lower-case, dot-prefixed extensions per language id. */
export const SOURCE_LANGUAGE_EXTENSIONS: Readonly<Record<SourceLanguageId, readonly string[]>> = {
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  vue: [".vue"],
  svelte: [".svelte"],
  astro: [".astro"],
  php: [".php", ".phtml", ".inc"],
  python: [".py", ".pyw"],
  swift: [".swift"],
  go: [".go"],
  rust: [".rs"],
  ruby: [".rb", ".rake", ".erb"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  csharp: [".cs"],
};

/** All language ids, in declaration order. */
export const SOURCE_LANGUAGE_IDS: readonly SourceLanguageId[] = Object.keys(
  SOURCE_LANGUAGE_EXTENSIONS,
) as SourceLanguageId[];

const BY_EXT: ReadonlyMap<string, SourceLanguageId> = new Map(
  SOURCE_LANGUAGE_IDS.flatMap((id) => SOURCE_LANGUAGE_EXTENSIONS[id].map((e): [string, SourceLanguageId] => [e, id])),
);

/**
 * Language id for a dot-prefixed extension (case-insensitive).
 * @param ext - Extension including the dot, e.g. `".tsx"`.
 * @returns The language id, or `undefined` when the extension is unknown.
 */
export function languageOfExtension(ext: string): SourceLanguageId | undefined {
  return BY_EXT.get(ext.toLowerCase());
}

/**
 * Language id for a file name or path, from its last extension.
 * @param path - File name or path.
 * @returns The language id, or `undefined` when unknown or extension-less.
 */
export function sourceLanguageOf(path: string): SourceLanguageId | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? undefined : languageOfExtension(base.slice(dot));
}

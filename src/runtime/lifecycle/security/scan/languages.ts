/**
 * @module security/scan/languages
 * Per-file language detection (extension based, shared table in
 * `util/source-languages`) plus the legacy root-marker `detectLanguage`.
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sourceLanguageOf, type SourceLanguageId } from "../../../../util/source-languages";
import { GENERATED_RE } from "./constants";

/** Scanner file kind: a source language, or `text` (secrets-only config/text files). */
export type FileLang = SourceLanguageId | "text";

const TEXT_EXTS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".plist", ".gradle",
  ".sh", ".bash", ".zsh", ".tf", ".tfvars", ".pem", ".key",
]);
const TEXT_NAMES = new Set([".npmrc", ".pypirc", ".netrc"]);

/**
 * Classify a file by name. `.env*` templates and generated files return undefined.
 * @param name - base file name
 * @returns the file kind, or `undefined` when the file is not scanned
 */
export function languageOf(name: string): FileLang | undefined {
  if (GENERATED_RE.test(name)) return undefined;
  const lower = name.toLowerCase();
  const src = sourceLanguageOf(lower);
  if (src) return src;
  if (lower === ".env" || lower.startsWith(".env.") || TEXT_NAMES.has(lower)) return "text";
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTS.has(lower.slice(dot)) ? "text" : undefined;
}

/** Root markers of the pre-coverage scanner (first match wins, order matters). */
const LEGACY_MARKERS: readonly (readonly [string, string])[] = [
  ["package.json", "javascript"], ["composer.json", "php"], ["requirements.txt", "python"],
  ["pyproject.toml", "python"], ["Package.swift", "swift"], ["go.mod", "go"], ["Cargo.toml", "rust"],
];

/** Detect the project language from root config files (legacy `language` value, unchanged). */
export function detectLanguage(dir: string): string {
  for (const [file, lang] of LEGACY_MARKERS) if (existsSync(join(dir, file))) return lang;
  return "unknown";
}

/**
 * @module security/scan/patterns
 * Rule tables per file kind. Every source language also gets the secrets table.
 * @packageDocumentation
 */
import type { FileLang } from "../languages";
import type { ScanPattern } from "../types";
import { CSHARP_RULES, JAVA_RULES, JVM_RULES, KOTLIN_RULES, RUBY_RULES } from "./managed";
import { GO_RULES, RUST_RULES, SWIFT_RULES } from "./native";
import { JS_RULES } from "./js";
import { PHP_RULES, PY_RULES } from "./php-py";
import { SECRET_RULES } from "./secrets";

const own = (lang: FileLang): ScanPattern[] => {
  switch (lang) {
    case "javascript": case "typescript": case "vue": case "svelte": case "astro": return JS_RULES;
    case "php": return PHP_RULES;
    case "python": return PY_RULES;
    case "swift": return SWIFT_RULES;
    case "go": return GO_RULES;
    case "rust": return RUST_RULES;
    case "ruby": return RUBY_RULES;
    case "java": return [...JVM_RULES, ...JAVA_RULES];
    case "kotlin": return [...JVM_RULES, ...KOTLIN_RULES];
    case "csharp": return CSHARP_RULES;
    case "text": return [];
  }
};

const CACHE = new Map<string, ScanPattern[]>();

/**
 * Ordered rules for a file kind: language table first (legacy first), then secrets.
 * @param lang - file kind
 * @param withLegacy - include the 18 legacy rules; only for files the legacy scanner read
 */
export function patternsFor(lang: FileLang, withLegacy = true): ScanPattern[] {
  const key = `${lang}:${withLegacy}`;
  let p = CACHE.get(key);
  if (!p) {
    p = [...own(lang), ...SECRET_RULES].filter((r) => withLegacy || !r.legacy);
    CACHE.set(key, p);
  }
  return p;
}

/** Every distinct rule (for tests and docs), in table order. */
export function allPatterns(): ScanPattern[] {
  const seen = new Map<string, ScanPattern>();
  const langs: FileLang[] = ["javascript", "php", "python", "swift", "go", "rust", "ruby", "java", "kotlin", "csharp", "text"];
  for (const l of langs) for (const p of patternsFor(l)) seen.set(p.id, p);
  return [...seen.values()];
}

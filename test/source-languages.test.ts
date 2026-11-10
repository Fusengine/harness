import { describe, expect, test } from "bun:test";
import {
  languageOfExtension, SOURCE_LANGUAGE_EXTENSIONS, SOURCE_LANGUAGE_IDS, sourceLanguageOf,
} from "../src/util/source-languages";

describe("source-languages", () => {
  test("language ids are the stable documented set", () => {
    expect([...SOURCE_LANGUAGE_IDS]).toEqual([
      "javascript", "typescript", "vue", "svelte", "astro", "php", "python", "swift", "go", "rust", "ruby", "java", "kotlin", "csharp",
    ]);
  });
  test("extension lookup is case-insensitive and dot-prefixed", () => {
    expect(languageOfExtension(".TSX")).toBe("typescript");
    expect(languageOfExtension("tsx")).toBeUndefined();
  });
  test("path lookup uses the last extension", () => {
    expect(sourceLanguageOf("a/b/x.blade.php")).toBe("php");
    expect(sourceLanguageOf("Makefile")).toBeUndefined();
    expect(sourceLanguageOf("dir.js/readme")).toBeUndefined();
  });
  test("no extension is claimed by two languages", () => {
    const all = Object.values(SOURCE_LANGUAGE_EXTENSIONS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

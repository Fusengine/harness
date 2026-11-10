/**
 * Coverage: TS/TSX, monorepos, Go, Rust, every supported extension, secrets
 * in text files, and the `coverage` block itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { relative } from "node:path";
import { runSecurityScan } from "../src/runtime/lifecycle/security/scan";
import { cleanupTrees, FAKE_AWS, makeTree } from "./scan/builders";
import { EXT_MATRIX, GO_SVC, MONOREPO, RUST_CRATE, TS_APP } from "./scan/fixtures-wide";

afterAll(cleanupTrees);

function files(root: string, rep: ReturnType<typeof runSecurityScan>, pred: (id: string) => boolean = () => true): string[] {
  return [...new Set(rep.findings.filter((f) => pred(f.id)).map((f) => relative(root, f.file)))].sort();
}

describe("TypeScript project", () => {
  const root = makeTree(TS_APP);
  const rep = runSecurityScan(root);
  test("every JS/TS extension is scanned, declarations and dependencies are not", () => {
    expect(files(root, rep)).toEqual(["src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts", "src/e.jsx", "src/f.mjs", "src/g.cjs", "src/h.js", "src/i.ts"]);
  });
  test("legacy language stays, coverage tells the truth", () => {
    expect(rep.language).toBe("javascript");
    expect(rep.coverage.primaryLanguage).toBe("typescript");
    expect(rep.coverage.filesScanned).toEqual({ typescript: 5, javascript: 4, text: 2 });
    expect(rep.coverage.skipped.generated).toBe(1);
    expect(rep.coverage.skipped.excludedDirs).toBe(1);
  });
});

describe("Next.js + Laravel monorepo", () => {
  const root = makeTree(MONOREPO);
  const rep = runSecurityScan(root);
  test("both languages report; vendor and framework caches are excluded", () => {
    expect(files(root, rep).filter((f) => !f.endsWith(".env"))).toEqual([
      "apps/api/app/Http/C.php", "apps/api/resources/views/x.blade.php", "apps/web/app/page.tsx", "apps/web/lib/db.ts",
      "packages/ui/a.vue", "packages/ui/b.svelte", "packages/ui/c.astro",
    ]);
  });
  test("legacy language is the root marker, projects map lists both apps", () => {
    expect(rep.language).toBe("javascript");
    const roots = rep.coverage.projects.map((p) => `${p.root}:${p.marker}`);
    expect(roots).toContain(".:package.json");
    expect(roots).toContain("apps/api:composer.json");
    expect(roots).toContain("apps/web:package.json");
  });
  test("secrets are found in .env (text) and typed as language text", () => {
    const env = rep.findings.filter((f) => f.file.endsWith(".env"));
    expect(env.map((f) => [f.id, f.language])).toEqual([["sec.aws.access-key", "text"]]);
    expect(rep.coverage.filesScanned.php).toBe(2);
  });
});

describe("Go and Rust projects", () => {
  test("Go: findings with language go, legacy language go", () => {
    const root = makeTree(GO_SVC);
    const rep = runSecurityScan(root);
    expect(rep.language).toBe("go");
    expect(files(root, rep)).toEqual(["internal/x.go", "main.go"]);
    expect(rep.findings.every((f) => f.language === "go")).toBe(true);
  });
  test("Rust: target/ excluded because Cargo.toml sits beside it", () => {
    const root = makeTree(RUST_CRATE);
    const rep = runSecurityScan(root);
    expect(rep.language).toBe("rust");
    expect(files(root, rep)).toEqual(["src/main.rs"]);
  });
});

describe("extension matrix", () => {
  const spec = Object.fromEntries(EXT_MATRIX.map(([ext, line]) => [`f.${ext}`, `${line}\n`]));
  const root = makeTree(spec);
  const rep = runSecurityScan(root);
  for (const [ext, , lang, id] of EXT_MATRIX) {
    test(`.${ext} -> ${lang} finding ${id}`, () => {
      const hit = rep.findings.find((f) => f.file.endsWith(`/f.${ext}`) && f.id === id);
      expect(hit?.language).toBe(lang);
    });
  }
  test("coverage lists every language", () => {
    expect(rep.coverage.languages.sort()).toEqual(
      ["astro", "csharp", "go", "java", "javascript", "kotlin", "php", "python", "ruby", "rust", "svelte", "swift", "typescript", "vue"],
    );
  });
});

describe("coverage block", () => {
  test("shape, sums and unsupported extensions", () => {
    const root = makeTree({ "a.ts": "eval(x)\n", "b.lua": "x\n", "c.lua": "x\n", "d.dart": "x\n", "e.json": `{"k":"${FAKE_AWS}"}\n`, "notes.md": `${FAKE_AWS}\n` });
    const c = runSecurityScan(root).coverage;
    expect(Object.keys(c)).toEqual(["patternSetVersion", "primaryLanguage", "languages", "filesScanned", "patternsApplied", "totals", "projects", "skipped", "unsupported", "limits"]);
    expect(Object.values(c.filesScanned).reduce((a, b) => a + b, 0)).toBe(c.totals.files);
    expect(c.filesScanned).toEqual({ text: 1, typescript: 1 });
    expect(c.unsupported).toEqual({ ".lua": 2, ".dart": 1 });
    expect(c.limits.maxFileBytes).toBe(1048576);
  });
});

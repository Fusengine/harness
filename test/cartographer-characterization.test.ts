import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getFileDesc } from "../src/runtime/lifecycle/cartographer/fs-util";
import { generateProjectMap } from "../src/runtime/lifecycle/cartographer/project-map";

/** Frozen fixture: relative path -> file content (legacy-described and non-described kinds). */
const FIXTURE: Readonly<Record<string, string>> = {
  "front.md": "---\nname: x\ndescription: Frontmatter wins\n---\n# Heading\nbody",
  "long.md": `---\ndescription: ${"d".repeat(90)}\n---\n# H`,
  "heading.md": "intro line\n\n# Only Heading Here\ntext",
  "plain.md": "no heading and no frontmatter\njust text",
  "bom.md": "﻿---\ndescription: bom field\n---\n# Bom Heading",
  "block.md": "---\ndescription: |\n---\n# After Block Scalar",
  "UPPER.MD": "# Upper ext is not described",
  "slash.ts": "// ts comment\nexport const a = 1;",
  "hash.tsx": "# hash in tsx\nexport const b = 2;",
  "shebang.js": "#!/usr/bin/env node\n// js after shebang\n",
  "late.jsx": "const a = 1;\n// late comment\n",
  "none.ts": "export const z = 1;\n",
  "doc.py": '"""Module docstring."""\nimport os\n',
  "hash.py": "#!/usr/bin/env python\n# py comment\n",
  "sq.py": "'''Single quoted doc'''\n",
  "slash.swift": "// swift comment\nimport Foundation\n",
  "long.swift": `// ${"s".repeat(100)}\n`,
  "tenth.ts": `${"\n".repeat(9)}// line ten\n`,
  "eleventh.ts": `${"\n".repeat(10)}// line eleven\n`,
  "sub/nested.md": "# Nested",
  "doc.pdf": "%PDF-1.4 // not a comment\n# nope\n",
  "img.png": "\u0089PNG\r\n\u001a\n// no",
  "data.xyz": "// unknown ext\n",
  "data.json": '{"// a": 1}',
  Makefile: "# make comment\n",
};

/** Golden descriptions produced by the pre-change implementation (frozen). */
const GOLDEN: Readonly<Record<string, string>> = {
  "front.md": "Frontmatter wins",
  "long.md": "d".repeat(60),
  "heading.md": "Only Heading Here",
  "plain.md": "",
  "bom.md": "Bom Heading",
  "block.md": "After Block Scalar",
  "UPPER.MD": "",
  "slash.ts": "ts comment",
  "hash.tsx": "hash in tsx",
  "shebang.js": "js after shebang",
  "late.jsx": "late comment",
  "none.ts": "",
  "doc.py": "Module docstring.",
  "hash.py": "py comment",
  "sq.py": "Single quoted doc",
  "slash.swift": "swift comment",
  "long.swift": "s".repeat(60),
  "tenth.ts": "line ten",
  "eleventh.ts": "",
  "sub/nested.md": "Nested",
  "doc.pdf": "",
  "img.png": "",
  "data.xyz": "",
  "data.json": "",
  Makefile: "",
};

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-carto-char-"));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return dir;
}

test("characterization: getFileDesc output is frozen for every fixture kind", () => {
  const dir = build();
  try {
    const got: Record<string, string> = {};
    for (const rel of Object.keys(FIXTURE)) got[rel] = getFileDesc(join(dir, rel));
    expect(got).toEqual(GOLDEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("characterization: generateProjectMap index lines carry the frozen descriptions", () => {
  const dir = build();
  writeFileSync(join(dir, "package.json"), "{}", "utf-8");
  try {
    generateProjectMap(dir);
    const idx = readFileSync(join(dir, ".cartographer/project/index.md"), "utf-8");
    for (const [rel, desc] of Object.entries(GOLDEN)) {
      if (rel.includes("/")) continue;
      const line = idx.split("\n").find((l) => l.includes(`[${rel}](`));
      expect(line).toBeDefined();
      expect(line!.endsWith(desc ? ` — ${desc}` : `${join(dir, rel)})`)).toBe(true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

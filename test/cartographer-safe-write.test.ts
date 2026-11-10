import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { generateProjectMap } from "../src/runtime/lifecycle/cartographer/project-map";
import { generateEcosystemMap } from "../src/runtime/lifecycle/cartographer/ecosystem-map";
import { trackEnrichment } from "../src/runtime/lifecycle/cartographer/track-enrichment";

/** A project (package.json + one source file), a victim file outside it, and an outside dir. */
function setup(): { proj: string; victim: string; outside: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "fh-carto-sw-"));
  const proj = join(root, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "package.json"), "{}");
  writeFileSync(join(proj, "src", "a.ts"), "// a module\n");
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "SECRET");
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { proj, victim, outside, root };
}

const isRegular = (p: string): boolean => lstatSync(p).isFile();

test("index.md symlinked to a user file: the file is untouched, the link is replaced by the map", () => {
  const { proj, victim, root } = setup();
  try {
    mkdirSync(join(proj, ".cartographer/project/src"), { recursive: true });
    symlinkSync(victim, join(proj, ".cartographer/project/index.md"));
    symlinkSync(victim, join(proj, ".cartographer/project/src/index.md"));
    generateProjectMap(proj);
    expect(readFileSync(victim, "utf-8")).toBe("SECRET");
    for (const [rel, entry] of [["index.md", "package.json"], ["src/index.md", "a.ts"]] as const) {
      const p = join(proj, ".cartographer/project", rel);
      expect(isRegular(p)).toBe(true);
      expect(readFileSync(p, "utf-8")).toContain(entry);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".enriched.json symlinked to a user file: untouched, link replaced by the sidecar", () => {
  const { proj, victim, root } = setup();
  try {
    const dir = join(proj, ".cartographer/project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.md"), "# p\n├── [x](./x) — manual desc\n");
    symlinkSync(victim, join(dir, ".enriched.json"));
    trackEnrichment(join(dir, "index.md"));
    expect(readFileSync(victim, "utf-8")).toBe("SECRET");
    expect(isRegular(join(dir, ".enriched.json"))).toBe(true);
    expect(readFileSync(join(dir, ".enriched.json"), "utf-8")).toContain("manual desc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output directory symlinked outside .cartographer: skipped, nothing written outside", () => {
  const { proj, outside, root } = setup();
  try {
    mkdirSync(join(proj, ".cartographer"), { recursive: true });
    symlinkSync(outside, join(proj, ".cartographer/project"));
    expect(() => generateProjectMap(proj)).not.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sub-directory symlinked outside is skipped, the rest of the tree is still written", () => {
  const { proj, outside, root } = setup();
  try {
    mkdirSync(join(proj, ".cartographer/project"), { recursive: true });
    symlinkSync(outside, join(proj, ".cartographer/project/src"));
    expect(() => generateProjectMap(proj)).not.toThrow();
    expect(readdirSync(outside)).toEqual([]);
    expect(isRegular(join(proj, ".cartographer/project/index.md"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ecosystem map: index.md symlinked to a user file is replaced, not followed", () => {
  const { victim, root } = setup();
  try {
    const plugins = join(root, "plugins");
    mkdirSync(join(plugins, ".cartographer"), { recursive: true });
    symlinkSync(victim, join(plugins, ".cartographer/index.md"));
    generateEcosystemMap(0, plugins);
    expect(readFileSync(victim, "utf-8")).toBe("SECRET");
    expect(isRegular(join(plugins, ".cartographer/index.md"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

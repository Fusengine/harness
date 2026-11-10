import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateEcosystemMap } from "../src/runtime/lifecycle/cartographer/ecosystem-map";
import { scanPlugin } from "../src/runtime/lifecycle/cartographer/scan";
import { readDescription } from "../src/runtime/lifecycle/cartographer/bounded-read";
import { MAX_PLUGIN_STRING } from "../src/runtime/lifecycle/cartographer/scan";
import { MIB, runCarto } from "./helpers/carto-rss";

/** A temp root with `plugins/foo` (agents/, skills/, commands/, hooks/, .claude-plugin/) and `outside/`. */
function fixture(): { root: string; plugins: string; foo: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "fh-eco-c-"));
  const plugins = join(root, "plugins");
  const foo = join(plugins, "foo");
  for (const d of ["agents", "skills", "commands", "hooks", ".claude-plugin"]) mkdirSync(join(foo, d), { recursive: true });
  writeFileSync(join(foo, "agents/a.md"), "---\nname: a\ndescription: d\n---\n");
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { root, plugins, foo, outside };
}

/** Hard-link `n` copies of a ~1 MiB agent file whose frontmatter `field` is ~1 MiB. */
function amplify(foo: string, field: string, n: number): void {
  const seed = join(foo, "seed.bin");
  writeFileSync(seed, `---\n${field}: ${"a".repeat(MIB - 200)}\n---\nbody\n`);
  for (let i = 0; i < n; i++) linkSync(seed, join(foo, "agents", `x${i}.md`));
}

test("hard-link amplification of a 1 MiB name stays bounded in RSS (ecosystem scan)", async () => {
  const base = fixture();
  const heavy = fixture();
  try {
    amplify(heavy.foo, "name", 60);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3 && best >= 128; i++) {
      const h = await runCarto(heavy.plugins, true);
      const b = await runCarto(base.plugins, true);
      expect(h.exitCode).toBe(0);
      best = Math.min(best, h.rssMiB - b.rssMiB);
    }
    expect(best).toBeLessThan(128);
  } finally {
    rmSync(base.root, { recursive: true, force: true });
    rmSync(heavy.root, { recursive: true, force: true });
  }
}, 90_000);

test("every string kept from plugin files is capped (agent name, skill description, hook event)", () => {
  const { root, foo } = fixture();
  try {
    const long = "n".repeat(5000);
    writeFileSync(join(foo, "agents/long.md"), `---\nname: ${long}\n---\n`);
    mkdirSync(join(foo, "skills/s"));
    writeFileSync(join(foo, "skills/s/SKILL.md"), `---\ndescription: ${long}\n---\n`);
    writeFileSync(join(foo, "hooks/hooks.json"), JSON.stringify({ hooks: { [long]: [] } }));
    const rows = scanPlugin(foo);
    expect(rows.length).toBeGreaterThan(3);
    for (const [, name, desc] of rows) {
      expect(name.length).toBeLessThanOrEqual(MAX_PLUGIN_STRING + 1);
      expect(desc.length).toBeLessThanOrEqual(MAX_PLUGIN_STRING);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked plugin dir is skipped (listed as skipped) and never written into", () => {
  const { root, plugins, outside } = fixture();
  try {
    const other = join(root, "other-project");
    mkdirSync(join(other, ".cartographer"), { recursive: true });
    writeFileSync(join(other, ".cartographer/index.md"), "SECRET");
    symlinkSync(other, join(plugins, "evil"));
    const fresh = join(root, "fresh-project");
    mkdirSync(fresh);
    symlinkSync(fresh, join(plugins, "evil2"));
    symlinkSync("/", join(plugins, "evil3"));
    expect(() => generateEcosystemMap(0, plugins)).not.toThrow();
    expect(readFileSync(join(other, ".cartographer/index.md"), "utf-8")).toBe("SECRET");
    expect(readdirSync(join(other, ".cartographer"))).toEqual(["index.md"]);
    expect(existsSync(join(fresh, ".cartographer"))).toBe(false);
    expect(existsSync("/.cartographer")).toBe(false);
    const index = readFileSync(join(plugins, ".cartographer/index.md"), "utf-8");
    expect(index).toContain("evil — skipped (symlinked directory)");
    expect(index).toContain("[foo](./foo/index.md)");
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked skills/agents/commands/hooks sub-directories are not followed", () => {
  const { root, plugins, foo, outside } = fixture();
  try {
    mkdirSync(join(outside, "leaked-skill"));
    writeFileSync(join(outside, "leaked-skill/SKILL.md"), "---\ndescription: leaked\n---\n");
    writeFileSync(join(outside, "leaked-agent.md"), "---\nname: leaked-agent\n---\n");
    writeFileSync(join(outside, "hooks.json"), JSON.stringify({ hooks: { LeakedEvent: [] } }));
    rmSync(join(foo, "skills"), { recursive: true });
    rmSync(join(foo, "agents"), { recursive: true });
    rmSync(join(foo, "hooks"), { recursive: true });
    symlinkSync(outside, join(foo, "skills"));
    symlinkSync(outside, join(foo, "agents"));
    symlinkSync(outside, join(foo, "hooks"));
    generateEcosystemMap(0, plugins);
    const rows = scanPlugin(foo);
    expect(rows).toEqual([]);
    const all = readFileSync(join(plugins, ".cartographer/foo/index.md"), "utf-8");
    expect(all).not.toContain("leaked");
    expect(existsSync(join(foo, ".cartographer/skills"))).toBe(false);
    expect(existsSync(join(foo, ".cartographer/agents"))).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(["hooks.json", "leaked-agent.md", "leaked-skill"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readDescription text is byte-identical to readFileSync for small files (BOM, invalid UTF-8, empty)", () => {
  const { root } = fixture();
  try {
    const cases: Record<string, Buffer> = {
      bom: Buffer.from("﻿# Title\n"),
      bad: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]),
      empty: Buffer.alloc(0),
      plain: Buffer.from("// hi\n".repeat(100)),
    };
    for (const [name, buf] of Object.entries(cases)) {
      const p = join(root, `${name}.ts`);
      writeFileSync(p, buf);
      expect(readDescription(p)).toEqual({ text: readFileSync(p, "utf-8"), truncated: false });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

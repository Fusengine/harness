import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { generateEcosystemMap } from "../src/runtime/lifecycle/cartographer/ecosystem-map";
import { readBoundedFd } from "../src/runtime/lifecycle/cartographer/bounded-read";
import { isSafePathSegment, isWithin } from "../src/runtime/lifecycle/cartographer/safe-write";
import { MIB, runCarto, sparse } from "./helpers/carto-rss";

/** Plugins dir with one plugin `foo` (agents/, skills/, commands/, hooks/, plugin.json) ready for a trap. */
function plugins(): { root: string; dir: string; foo: string } {
  const root = mkdtempSync(join(tmpdir(), "fh-eco-b-"));
  const dir = join(root, "plugins");
  const foo = join(dir, "foo");
  for (const d of ["agents", "skills/s", "commands", "hooks", ".claude-plugin"]) mkdirSync(join(foo, d), { recursive: true });
  writeFileSync(join(foo, "agents/a.md"), "---\nname: a\ndescription: d\n---\n");
  return { root, dir, foo };
}

/** Best-of-3 RSS delta (MiB) of the ecosystem run over a clean `base`. */
async function ecoDelta(heavy: string, base: string): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3 && best >= 128; i++) {
    const h = await runCarto(heavy, true);
    const b = await runCarto(base, true);
    expect(h.exitCode).toBe(0);
    best = Math.min(best, h.rssMiB - b.rssMiB);
  }
  return best;
}

const TRAPS: ReadonlyArray<readonly [string, (foo: string) => void]> = [
  ["agents/a.md oversize", (f) => sparse(join(f, "agents/a.md"), 512 * MIB)],
  ["skills/s/SKILL.md oversize", (f) => sparse(join(f, "skills/s/SKILL.md"), 512 * MIB)],
  ["commands/c.md oversize", (f) => sparse(join(f, "commands/c.md"), 512 * MIB)],
  ["hooks/hooks.json oversize", (f) => sparse(join(f, "hooks/hooks.json"), 512 * MIB)],
  ["plugin.json oversize", (f) => sparse(join(f, ".claude-plugin/plugin.json"), 512 * MIB)],
  ["agents/a.md -> /dev/zero", (f) => { rmSync(join(f, "agents/a.md")); symlinkSync("/dev/zero", join(f, "agents/a.md")); }],
  ["skills/s/SKILL.md -> /dev/zero", (f) => symlinkSync("/dev/zero", join(f, "skills/s/SKILL.md"))],
  ["commands/c.md -> /dev/zero", (f) => symlinkSync("/dev/zero", join(f, "commands/c.md"))],
  ["hooks/hooks.json -> /dev/zero", (f) => symlinkSync("/dev/zero", join(f, "hooks/hooks.json"))],
  ["plugin.json -> /dev/zero", (f) => symlinkSync("/dev/zero", join(f, ".claude-plugin/plugin.json"))],
];

test.each(TRAPS)("ecosystem scan never reads an oversize or device file: %s", async (_label, plant) => {
  const base = plugins();
  const heavy = plugins();
  try {
    plant(heavy.foo);
    expect(await ecoDelta(heavy.dir, base.dir)).toBeLessThan(128);
  } finally {
    rmSync(base.root, { recursive: true, force: true });
    rmSync(heavy.root, { recursive: true, force: true });
  }
}, 60_000);

test("readBoundedFd: caps the bytes actually read, whatever stat claims (size-0 pseudo-files)", () => {
  const root = mkdtempSync(join(tmpdir(), "fh-eco-fd-"));
  try {
    const small = join(root, "small");
    const big = join(root, "big");
    writeFileSync(small, "hello");
    writeFileSync(big, Buffer.alloc(4 * MIB, 97));
    const open = (p: string): number => openSync(p, "r");
    const a = open(small);
    const b = open(big);
    expect(readBoundedFd(a, MIB)).toBe("hello");
    expect(readBoundedFd(b, MIB)).toBeUndefined();
    expect(readBoundedFd(open(big), 4 * MIB)?.length).toBe(4 * MIB);
    closeSync(a);
    closeSync(b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSafePathSegment / isWithin", () => {
  for (const ok of ["foo", "fuse-ai-pilot", "a.b", "Plugin 1"]) expect(isSafePathSegment(ok)).toBe(true);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", ".hidden", "a\0b", "x".repeat(300)]) {
    expect(isSafePathSegment(bad)).toBe(false);
  }
  expect(isWithin("/r/.cartographer", "/r/.cartographer/foo")).toBe(true);
  expect(isWithin("/r/.cartographer", "/r/.cartographer/../victim")).toBe(false);
  expect(isWithin("/r/.cartographer", "/r/.cartographer-evil/x")).toBe(false);
  expect(isWithin("/r/.cartographer", "/r/.cartographer")).toBe(false);
});

const NAMES = ["../../victimdir", "../victimdir", "a/../../victimdir", "/abs/victimdir", "..", ".hidden"];

test.each(NAMES)("plugin.json name %p never writes outside .cartographer", (name) => {
  const { root, dir, foo } = plugins();
  try {
    const victim = join(root, "victimdir");
    mkdirSync(victim);
    writeFileSync(join(victim, "index.md"), "SECRET");
    writeFileSync(join(foo, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    expect(() => generateEcosystemMap(0, dir)).not.toThrow();
    expect(readFileSync(join(victim, "index.md"), "utf-8")).toBe("SECRET");
    expect(existsSync(join(root, "index.md"))).toBe(false);
    // the plugin is still listed, under its directory name
    expect(readFileSync(join(dir, ".cartographer/index.md"), "utf-8")).toContain("[foo](./foo/index.md)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

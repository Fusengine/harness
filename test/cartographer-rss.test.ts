import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { MIB, runCarto, sparse } from "./helpers/carto-rss";

/** Project with a few small files, optionally plus a `big.pdf` sparse file. */
function project(bigBytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-carto-rss-"));
  writeFileSync(join(dir, "package.json"), "{}");
  mkdirSync(join(dir, "src"));
  for (let i = 0; i < 50; i++) writeFileSync(join(dir, "src", `f${i}.ts`), `// file ${i}\nexport const x = ${i};\n`);
  if (bigBytes > 0) sparse(join(dir, "big.pdf"), bigBytes);
  return dir;
}

/** Best-of-3 RSS delta (MiB) of `heavy` over `base`; stops early once under the bound. */
async function bestDelta(heavy: string, base: string): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3 && best >= 128; run++) {
    const h = await runCarto(heavy);
    const b = await runCarto(base);
    expect(h.exitCode).toBe(0);
    best = Math.min(best, h.rssMiB - b.rssMiB);
  }
  return best;
}

/** Assert `heavy` stays within 128 MiB RSS of a fresh baseline project, then remove both dirs. */
async function expectBoundedRss(heavy: string): Promise<void> {
  const base = project(0);
  try {
    expect(await bestDelta(heavy, base)).toBeLessThan(128);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(heavy, { recursive: true, force: true });
  }
}

test("a 512 MiB sparse .pdf does not inflate the cartographer's peak RSS (#121)", async () => {
  await expectBoundedRss(project(512 * MIB));
}, 60_000);

/** Project whose existing `.cartographer/project/<name>` is produced by `plant`. */
function trapped(name: string, plant: (path: string) => void): string {
  const dir = project(0);
  mkdirSync(join(dir, ".cartographer/project"), { recursive: true });
  plant(join(dir, ".cartographer/project", name));
  return dir;
}

const TRAPS: ReadonlyArray<readonly [string, string, (p: string) => void]> = [
  ["index.md symlinked to /dev/zero", "index.md", (p) => symlinkSync("/dev/zero", p)],
  [".enriched.json symlinked to /dev/zero", ".enriched.json", (p) => symlinkSync("/dev/zero", p)],
  ["oversize (512 MiB sparse) index.md", "index.md", (p) => sparse(p, 512 * MIB)],
  ["oversize (512 MiB sparse) .enriched.json", ".enriched.json", (p) => sparse(p, 512 * MIB)],
];

test.each(TRAPS)("merge never reads a device or an oversize file: %s", async (_label, name, plant) => {
  await expectBoundedRss(trapped(name, plant));
}, 60_000);

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

/** Bytes per MiB. */
export const MIB: number = 1024 * 1024;
const GENERATE = resolve(import.meta.dir, "../../src/runtime/lifecycle/cartographer/project-map");
const CHILD = `import { generateProjectMap } from ${JSON.stringify(GENERATE)}; generateProjectMap(process.env.CARTO_PROJ!);`;

const ECO = resolve(import.meta.dir, "../../src/runtime/lifecycle/cartographer/ecosystem-map");
const ECO_CHILD = `import { generateEcosystemMap } from ${JSON.stringify(ECO)}; generateEcosystemMap(0, process.env.CARTO_PROJ!);`;

/** Create a sparse file of `bytes` (no disk blocks written). */
export function sparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

/**
 * Peak RSS (MiB) of a fresh process running the cartographer over `dir`, plus
 * its exit code. HOME is isolated on the child's command line.
 */
export async function runCarto(dir: string, ecosystem: boolean = false): Promise<{ rssMiB: number; exitCode: number }> {
  const home = mkdtempSync(join(tmpdir(), "fh-carto-home-"));
  try {
    const proc = Bun.spawn([process.execPath, "-e", ecosystem ? ECO_CHILD : CHILD], {
      env: { PATH: process.env.PATH ?? "", HOME: home, CARTO_PROJ: dir },
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return { rssMiB: (proc.resourceUsage()?.maxRSS ?? Number.POSITIVE_INFINITY) / MIB, exitCode };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * EFFECT oracle: runs a composed command with bash inside a throwaway temp dir seeded with
 * {@link seedFiles} and reports whether the code file `src/x.ts` changed. Never touches anything else.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seedFiles } from "./monotone-atoms";

/** Run `cmd` under `bash -c` in a fresh temp dir; true when `src/x.ts` was modified, replaced or linked. */
export async function effect(cmd: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "fh-mono-fx-"));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const proc = Bun.spawn(["bash", "-c", cmd], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 10_000);
  await proc.exited;
  clearTimeout(timer);
  try {
    const target = join(dir, "src/x.ts");
    if (lstatSync(target).isSymbolicLink()) return true;
    return readFileSync(target, "utf8") !== seedFiles["src/x.ts"];
  } catch {
    return true;
  }
}

/** Map `items` through `fn` with at most `limit` concurrent runs (kept low: each run spawns a process). */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

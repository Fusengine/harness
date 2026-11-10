import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Our own file names in the guard-reports dir: `<sid>.<agentId>.json` emission records only (never any `.md`, which may predate us and belongs to the owner). */
const OURS = /\.json$/;

/**
 * Delete the guard-report files older than `retentionMs` (best effort, never throws).
 * Only regular files matching our name pattern are touched — never a directory or a
 * foreign file — and one failing entry never stops the loop.
 * @param dir - The guard-reports directory.
 * @param retentionMs - Age beyond which a file is removed.
 * @param now - Clock (epoch ms).
 */
export function pruneOld(dir: string, retentionMs: number, now: number = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    try {
      if (!OURS.test(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isFile() && now - st.mtimeMs > retentionMs) rmSync(path, { force: true });
    } catch { /* skip this entry */ }
  }
}

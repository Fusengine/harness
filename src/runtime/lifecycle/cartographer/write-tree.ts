/**
 * Recursive index.md tree writer. Ports `write_recursive.py`.
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getFileDesc, listChildren } from "./fs-util";
import { mergeLines } from "./merge";
import { isSafeOutputDir, writeFileReplacing } from "./safe-write";

/**
 * Write `index.md` files mirroring `source` under `output`, recursing into
 * subdirectories. Directory lines carry a file-count hint; file lines carry a
 * derived description and link to the real absolute source path.
 * @param source - Absolute source directory.
 * @param output - Absolute output directory for the index tree.
 * @param back - Relative `← back` link target ("" at the root).
 * @param exclude - Directory/name set to skip.
 * @returns Visible files under `source` (recursive); the parent reuses it for its
 *   `N files` hint, so each directory is listed once instead of once per ancestor.
 */
export function writeTree(source: string, output: string, back: string = "", exclude?: ReadonlySet<string>): number {
  const ex = exclude ?? new Set<string>();
  if (!isSafeOutputDir(output)) return 0; // symlinked output dir: never followed, nothing written
  mkdirSync(output, { recursive: true });
  const { dirs, files } = listChildren(source, ex);
  const lines: string[] = [`# ${basename(source)}\n`];
  if (back) lines.push(`> [← back](${back})\n`);
  const total = dirs.length + files.length;
  let idx = 0;
  let fileCount = files.length;
  for (const d of dirs) {
    idx += 1;
    const conn = idx === total ? "└──" : "├──";
    const sub = writeTree(d, join(output, basename(d)), "../index.md", exclude);
    fileCount += sub;
    const hint = sub ? ` — ${sub} files` : "";
    lines.push(`${conn} [${basename(d)}/](./${basename(d)}/index.md)${hint}`);
  }
  for (const f of files) {
    idx += 1;
    const conn = idx === total ? "└──" : "├──";
    const desc = getFileDesc(f);
    const suffix = desc ? ` — ${desc}` : "";
    lines.push(`${conn} [${basename(f)}](${f})${suffix}`);
  }
  const indexPath = join(output, "index.md");
  const merged = mergeLines(lines, indexPath);
  writeFileReplacing(indexPath, merged.join("\n") + "\n");
  return fileCount;
}

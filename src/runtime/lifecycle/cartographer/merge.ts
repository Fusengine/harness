/**
 * Index merge — preserves enriched descriptions across regenerations. Ports
 * `merge_index.py` (merge_lines + .enriched.json sidecar).
 */
import { dirname, join } from "node:path";
import { parseEntry } from "../../../policy/cartographer/entry";
import { readSmallRegularFile } from "./bounded-read";

/**
 * Load the `.enriched.json` sidecar's `entries` map for an output index. A
 * missing, non-regular (e.g. a symlink to a device) or oversize sidecar counts
 * as absent.
 * @param outputIndexPath - Path to the index.md being written.
 * @returns The path→desc enrichment map (possibly empty).
 */
export function loadEnriched(outputIndexPath: string): Record<string, string> {
  const raw = readSmallRegularFile(join(dirname(outputIndexPath), ".enriched.json"));
  if (raw === undefined) return {};
  try {
    const data = JSON.parse(raw) as { entries?: Record<string, string> };
    return data.entries ?? {};
  } catch {
    return {};
  }
}

/**
 * Merge freshly generated lines with prior descriptions: enriched sidecar wins,
 * else a longer pre-existing description is preserved. A missing, non-regular
 * or oversize existing index is treated as absent (fresh generation).
 * @param newLines - The freshly generated index lines.
 * @param outputIndexPath - Path to the existing index.md (if any).
 * @returns The merged lines.
 */
export function mergeLines(newLines: string[], outputIndexPath: string): string[] {
  const enriched = loadEnriched(outputIndexPath);
  const existingDescs: Record<string, string> = {};
  for (const line of (readSmallRegularFile(outputIndexPath) ?? "").split("\n")) {
    const e = parseEntry(line);
    if (e) existingDescs[e.path] = e.desc;
  }
  return newLines.map((line) => {
    const e = parseEntry(line);
    if (!e) return line;
    if (e.path in enriched) return `${e.prefix}[${e.name}](${e.path}) — ${enriched[e.path]}`;
    const old = existingDescs[e.path] ?? "";
    if (old.length > e.desc.length) return `${e.prefix}[${e.name}](${e.path}) — ${old}`;
    return line;
  });
}

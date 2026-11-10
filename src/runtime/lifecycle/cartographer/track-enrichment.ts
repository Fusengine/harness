/**
 * Enrichment tracker (PostToolUse Edit/Write on `.cartographer/**\/index.md`).
 * Ports `track-enrichment.py`: persists manual descriptions to a sidecar so the
 * next regeneration can preserve them.
 */
import { dirname, join } from "node:path";
import { parseEnrichment } from "../../../policy/cartographer/entry";
import { readSmallRegularFile } from "./bounded-read";
import { writeFileReplacing } from "./safe-write";

/** Shape of the `.enriched.json` sidecar. */
interface EnrichedSidecar {
  version: number;
  entries: Record<string, string>;
}

/**
 * Record manually-edited descriptions from a cartographer `index.md` into the
 * adjacent `.enriched.json` sidecar. No-op for unrelated paths. No stdout.
 * @param filePath - The edited file path.
 */
export function trackEnrichment(filePath: string): void {
  if (!filePath || !filePath.includes(".cartographer") || !filePath.endsWith("index.md")) return;
  const text = readSmallRegularFile(filePath);
  if (text === undefined) return;
  const sidecar = join(dirname(filePath), ".enriched.json");
  let existing: EnrichedSidecar = { version: 1, entries: {} };
  const rawSidecar = readSmallRegularFile(sidecar);
  if (rawSidecar !== undefined) {
    try {
      existing = JSON.parse(rawSidecar) as EnrichedSidecar;
    } catch { /* keep default */ }
  }
  const entries = (existing.entries ??= {});
  for (const line of text.split("\n")) {
    const e = parseEnrichment(line);
    if (e) entries[e[0]] = e[1];
  }
  try {
    writeFileReplacing(sidecar, JSON.stringify(existing, null, 2) + "\n");
  } catch { /* best effort */ }
}

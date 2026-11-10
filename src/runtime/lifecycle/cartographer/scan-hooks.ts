/**
 * Hook scanning (fs). Ports `_scan_hooks` from `scan_plugins.py`: reads a
 * plugin's `hooks/hooks.json` and reduces it to a single `("hooks", "<events>", "")`
 * row. The `hooks` value (or the whole document) is either a MAP of event →
 * entries (keys are the events) or a LIST of entries each carrying an `event`.
 */
import { join } from "node:path";
import type { ScanRow } from "../../../policy/cartographer/build-tree";
import { capPluginString, readSmallRegularFile } from "./bounded-read";
import { isRealDir } from "./safe-write";

/** Max distinct hook events kept per plugin. */
const MAX_EVENTS = 100;

/** True for a non-null plain object (excludes arrays), mirroring Python `isinstance(x, dict)`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Sort unique non-empty strings alpha (byte-order). */
function sortedEvents(events: Iterable<string>): string[] {
  const capped = [...events].filter((e) => e).map(capPluginString);
  return [...new Set(capped)].sort((a, b) => a.localeCompare(b, "en")).slice(0, MAX_EVENTS);
}

/** Derive hook event names from the `hooks.json` data (map keys, or list `event` fields). */
function hookEvents(hooksData: unknown): string[] {
  if (isPlainObject(hooksData)) {
    return sortedEvents(Object.keys(hooksData).filter((k) => !k.startsWith("_")));
  }
  if (Array.isArray(hooksData)) {
    return sortedEvents(hooksData.map((h) => (isPlainObject(h) ? String(h.event ?? "") : "")));
  }
  return [];
}

/**
 * Scan `hooks/hooks.json` into a single `("hooks", "<events>", "")` row.
 * @param root - Absolute plugin directory.
 * @returns The single hooks row, or `[]` when absent/empty/unreadable.
 */
export function scanHooks(root: string): ScanRow[] {
  const file = join(root, "hooks", "hooks.json");
  if (!isRealDir(join(root, "hooks"))) return [];
  const text = readSmallRegularFile(file);
  if (text === undefined) return [];
  try {
    const raw: unknown = JSON.parse(text);
    const hooksData = isPlainObject(raw) ? (raw.hooks ?? raw) : {};
    const events = hookEvents(hooksData);
    return events.length ? [["hooks", events.join(", "), ""]] : [];
  } catch {
    return [];
  }
}

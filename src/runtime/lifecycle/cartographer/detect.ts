/**
 * Plugin discovery (fs). Ports `detect_plugins.py`: marketplace `plugins` dir
 * resolution + `plugin.json` meta reading.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR } from "../../../config/dotenv";
import { detectHarness } from "../../../detect/harness";
import type { HarnessId } from "../../../detect/harness";
import { capPluginString, readSmallRegularFile } from "./bounded-read";

/** Sorted entry names of `dir` (alpha, byte-order), or `[]` on error. */
function sortedNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b, "en"));
  } catch {
    return [];
  }
}

/**
 * Read `[version, name]` from `<pluginPath>/.claude-plugin/plugin.json`.
 * @param pluginPath - Absolute plugin directory.
 * @returns The `[version, name]` pair (both "" when absent/unreadable).
 */
export function readPluginMeta(pluginPath: string): [string, string] {
  const pj = join(pluginPath, ".claude-plugin", "plugin.json");
  const raw = readSmallRegularFile(pj);
  if (raw === undefined) return ["", ""];
  try {
    const meta = JSON.parse(raw) as { version?: string; name?: string };
    // untrusted strings: capped (a non-string value counts as absent)
    const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? capPluginString(String(v)) : "");
    return [str(meta.version), str(meta.name)];
  } catch {
    return ["", ""];
  }
}

/**
 * Auto-detect the marketplace `plugins` dir that contains `cartographer`,
 * falling back to the first marketplace with a `plugins` dir, else `cwd`.
 * Ports `find_marketplace_plugins`, but harness-agnostic: the config dir is
 * derived from the detected harness (`.claude`, `.codex`, `.cursor`, …) via the
 * shared `HOME_DIR` mapping instead of a hardcoded `.claude`.
 * @param home - Home directory (defaults to `~`).
 * @param id - Detected harness id (defaults to runtime detection).
 * @returns The resolved plugins directory.
 */
export function findMarketplacePlugins(home: string = homedir(), id: HarnessId = detectHarness().id): string {
  const mp = join(home, HOME_DIR[id] ?? ".claude", "plugins", "marketplaces");
  const markets = sortedNames(mp);
  for (const m of markets) {
    if (existsSync(join(mp, m, "plugins", "cartographer"))) return join(mp, m, "plugins");
  }
  for (const m of markets) {
    if (existsSync(join(mp, m, "plugins"))) return join(mp, m, "plugins");
  }
  return process.cwd();
}

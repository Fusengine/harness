/**
 * Plugin scanning (fs). Ports `scan_plugins.py`: turns a plugin's
 * agents/skills/commands/hooks into ordered `[type, name, desc]` rows.
 * Plugin files are untrusted: every string kept is capped and symlinked
 * directories are never followed.
 */
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { ScanRow } from "../../../policy/cartographer/build-tree";
import { parseBodyDesc, parseField } from "../../../policy/cartographer/frontmatter";
import { capPluginString as cap, readSmallRegularFile } from "./bounded-read";
import { isRealDir } from "./safe-write";
import { scanHooks } from "./scan-hooks";

export { MAX_PLUGIN_STRING } from "./bounded-read";
/** Max rows kept per plugin (hard-linked or generated files cannot inflate the map). */
export const MAX_PLUGIN_ROWS = 5000;

/** Sorted entry names of a real (non-symlinked) directory, or `[]` on error or symlink. */
function sortedNames(dir: string): string[] {
  if (!isRealDir(dir)) return [];
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b, "en"));
  } catch {
    return [];
  }
}

/** Read a `.md` frontmatter field from a file path, "" when missing/unreadable. */
function fileField(path: string, field: string): string {
  const raw = readSmallRegularFile(path);
  return raw === undefined ? "" : cap(parseField(raw, field));
}

/** Scan `agents/*.md` → `("agent", name, desc[:50])` rows. */
export function scanAgents(root: string): ScanRow[] {
  const dir = join(root, "agents");
  return sortedNames(dir)
    .filter((n) => extname(n) === ".md")
    .map((n): ScanRow => {
      const raw = readSmallRegularFile(join(dir, n)); // one read per file: name + description
      const field = (key: string): string => (raw === undefined ? "" : cap(parseField(raw, key)));
      return ["agent", field("name") || cap(n.replace(/\.md$/, "")), field("description").slice(0, 50)];
    });
}

/** Scan `skills/<dir>/SKILL.md` → `("skill", dir, desc)` rows. */
function scanSkills(root: string): ScanRow[] {
  const dir = join(root, "skills");
  const rows: ScanRow[] = [];
  for (const name of sortedNames(dir)) {
    if (!isRealDir(join(dir, name))) continue;
    const raw = readSmallRegularFile(join(dir, name, "SKILL.md"));
    const desc = raw === undefined ? "" : cap(parseField(raw, "description") || parseBodyDesc(raw));
    rows.push(["skill", cap(name), desc || "(no description)"]);
  }
  return rows;
}

/** Scan `commands/*.md` → `("command", "/name", desc[:50])` rows. */
function scanCommands(root: string): ScanRow[] {
  const dir = join(root, "commands");
  return sortedNames(dir)
    .filter((n) => extname(n) === ".md")
    .map((n): ScanRow => ["command", `/${cap(n.replace(/\.md$/, ""))}`, fileField(join(dir, n), "description").slice(0, 50)]);
}

/**
 * Scan a single plugin directory into ordered `[type, name, desc]` rows
 * (at most {@link MAX_PLUGIN_ROWS}).
 * @param pluginDir - Absolute plugin directory.
 * @returns The agents + skills + commands + hooks rows.
 */
export function scanPlugin(pluginDir: string): ScanRow[] {
  return [...scanAgents(pluginDir), ...scanSkills(pluginDir), ...scanCommands(pluginDir), ...scanHooks(pluginDir)].slice(
    0,
    MAX_PLUGIN_ROWS,
  );
}

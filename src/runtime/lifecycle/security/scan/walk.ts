/**
 * @module security/scan/walk
 * Iterative directory walk (no recursion limit) with documented exclusions.
 * Entries are visited depth-first in `readdir` order, a subdirectory at the
 * position of its entry, exactly like the pre-coverage scanner (so legacy
 * findings keep their relative order). Directory symlinks are not followed;
 * file symlinks are visited (legacy parity).
 * @packageDocumentation
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONDITIONAL_DIRS, EXCLUDE_DIRS, LEGACY_EXCLUDE_DIRS, EXCLUDE_PAIRS, PROJECT_MARKERS, VENV_DIRS } from "./constants";

/** Callbacks driven by {@link walkTree}. */
export interface WalkHooks {
  file(path: string, name: string): void;
  excluded(): void;
  project(root: string, marker: string): void;
}

/** `restricted`: inside a widened-excluded dir, only legacy-read files and legacy exclusions apply. */
interface Frame { dir: string; entries: Dirent[]; names: string[]; i: number; restricted: boolean }

/** Whether directory `name` (full path `full`, parent entries `siblings`) is excluded. */
export function isExcludedDir(root: string, full: string, name: string, siblings: readonly string[]): boolean {
  if (EXCLUDE_DIRS.has(name)) return true;
  const cond = Object.hasOwn(CONDITIONAL_DIRS, name) ? CONDITIONAL_DIRS[name] : undefined;
  if (cond?.(siblings)) return true;
  if (VENV_DIRS.has(name) && existsSync(join(full, "pyvenv.cfg"))) return true;
  const rel = relative(root, full).split(sep).join("/");
  return EXCLUDE_PAIRS.some((p) => rel === p || rel.endsWith(`/${p}`));
}

function open(root: string, dir: string, h: WalkHooks, restricted: boolean): Frame | undefined {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  const names = entries.map((e) => e.name);
  const marker = PROJECT_MARKERS.find((m) => names.includes(m)) ?? names.find((n) => /\.(?:csproj|sln)$/.test(n));
  if (marker && !restricted) h.project(relative(root, dir) || ".", marker);
  return { dir, entries, names, i: 0, restricted };
}

/**
 * Walk `root`, reporting files, excluded directories and project markers.
 * No-regression rule: a widened exclusion never hides a file the legacy
 * scanner read. Such a directory is still entered, but only for files ending
 * in `legacyExt` (the extension of the root-detected language) and honouring
 * only the legacy exclusion set.
 * @param legacyExt - extension the legacy scanner read (`.js`, `.php`, ...), if any
 */
export function walkTree(root: string, h: WalkHooks, legacyExt?: string): void {
  const first = open(root, root, h, false);
  const stack: Frame[] = first ? [first] : [];
  while (stack.length > 0) {
    const fr = stack[stack.length - 1] as Frame;
    const e = fr.entries[fr.i++];
    if (!e) { stack.pop(); continue; }
    const full = join(fr.dir, e.name);
    if (!e.isDirectory()) {
      if (!fr.restricted || (legacyExt && e.name.endsWith(legacyExt))) h.file(full, e.name);
      continue;
    }
    const excluded = !fr.restricted && isExcludedDir(root, full, e.name, fr.names);
    if (fr.restricted) {
      if (LEGACY_EXCLUDE_DIRS.includes(e.name)) continue;
    } else if (excluded) {
      h.excluded();
      if (!legacyExt || LEGACY_EXCLUDE_DIRS.includes(e.name)) continue;
    }
    const next = open(root, full, h, fr.restricted || excluded);
    if (next) stack.push(next);
  }
}

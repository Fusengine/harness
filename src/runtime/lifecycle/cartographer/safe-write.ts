/**
 * Symlink-safe writes for cartographer output. A repository can commit
 * `.cartographer/**\/index.md -> ~/.bashrc` (or a symlinked directory); a plain
 * `writeFileSync` would follow it and overwrite the target on every SessionStart.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const MAP_DIR = ".cartographer";

/** True when `p` exists and is a symlink (a missing path is not). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether `p` is a real directory, not a symlink (to a directory or anything else).
 * @param p - Path to test (not followed if it is a symlink).
 * @returns True for a plain directory.
 */
export function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `name` is usable as ONE path component built from untrusted data
 * (e.g. a `plugin.json` name): non-empty, no `/`, `\`, NUL, not `.`/`..`, no
 * leading `.`, at most 255 chars.
 * @param name - Candidate path component.
 * @returns True when joining it cannot escape its parent directory.
 */
export function isSafePathSegment(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[/\\\0]/.test(name);
}

/**
 * Whether `path` resolves strictly inside `root` (resolve + `root + sep` prefix).
 * @param root - Containing directory.
 * @param path - Candidate path.
 * @returns True when `path` is a descendant of `root`.
 */
export function isWithin(root: string, path: string): boolean {
  return resolve(path).startsWith(resolve(root) + sep);
}

/**
 * Whether `dir` may be written to: no path component from the nearest
 * `.cartographer` ancestor (inclusive) down to `dir` is a symlink, so the output
 * tree cannot lead outside itself. Without a `.cartographer` ancestor only `dir`
 * itself is checked.
 * @param dir - Output directory (existing or not).
 * @returns False when a symlinked component would be followed.
 */
export function isSafeOutputDir(dir: string): boolean {
  const abs = resolve(dir);
  const parts = abs.split(sep);
  const start = parts.lastIndexOf(MAP_DIR);
  if (start < 0) return !isSymlink(abs);
  for (let i = start; i < parts.length; i++) {
    if (isSymlink(parts.slice(0, i + 1).join(sep) || sep)) return false;
  }
  return true;
}

/**
 * Write `data` to `dest` through a temp file in the same directory and
 * `renameSync` over it: the rename replaces a symlink at `dest` itself and
 * never follows it. Skipped (returns false) when the parent directory is unsafe
 * ({@link isSafeOutputDir}). Other errors propagate, like `writeFileSync`.
 * @param dest - Destination file path.
 * @param data - UTF-8 content.
 * @returns True when written, false when skipped.
 */
export function writeFileReplacing(dest: string, data: string): boolean {
  const dir = dirname(dest);
  if (!isSafeOutputDir(dir)) return false;
  const tmp = join(dir, `.${basename(dest)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return true;
}

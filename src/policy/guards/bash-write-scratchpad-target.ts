import { lstatSync } from "node:fs";

/** Characters an absolute scratchpad dir may contain; deliberately tiny so no expansion, quote, glob, brace or tilde form can occur. */
const DIR_CHARS = /^\/[A-Za-z0-9_.\-/]+$/;
/** Same charset for a single file component below the dir (no `/`). */
const COMPONENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate the session scratchpad dir sent by the host (`scratchpad_dir`).
 * Accepts only an absolute, plain, normalized path of at least three
 * segments (no `.`/`..`/empty segment); one trailing `/` is dropped.
 * @param raw - Raw payload value.
 * @returns The canonical dir without trailing slash, or null when unusable.
 */
export function scratchpadDirOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !DIR_CHARS.test(raw)) return null;
  const dir = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = dir.slice(1).split("/");
  if (segments.length < 3 || segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return dir;
}

/** True for a plain single file name: safe charset and not made only of dots (`.`, `..`, `...`). */
export function isPlainComponent(name: string): boolean {
  return COMPONENT.test(name) && !/^\.+$/.test(name);
}

/**
 * Physical check of the write target, without following anything: the
 * scratchpad dir itself must not be a symlink, and `dir/name` must be absent
 * (a new file) or an existing regular file with a single link. A symlink, a
 * directory or a hard-linked file keeps the old verdict. An absent dir is
 * tolerated (the shell redirect then fails on its own, creating nothing).
 * @param dir - Canonical scratchpad dir.
 * @param name - Single validated component below `dir`.
 * @returns True for a fresh name or a single-link regular file; false otherwise.
 */
export function isFreshOrRegular(dir: string, name: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    const stat = lstatSync(`${dir}/${name}`);
    return stat.isFile() && stat.nlink === 1;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

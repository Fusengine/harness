import { lstatSync, realpathSync } from "node:fs";

/** A system temp dir a redirect may target: the spellings accepted in a command and the physical directory behind them. */
export interface TempRoot {
  names: readonly string[];
  physical: string;
}

/** macOS per-user temp dir as `$TMPDIR` spells it (no dot-only segment, with or without the `/private` prefix). */
const USER_TMP = /^(?:\/private)?\/var\/folders\/(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+\/)[A-Za-z0-9_.-]+\/T$/;

/** Resolve one temp root; null when absent or not a real directory. */
function resolveRoot(names: readonly string[]): TempRoot | null {
  const physicalOf = (path: string): string | null => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const physical = physicalOf(names[0] ?? "");
  if (physical === null || !lstatSync(physical).isDirectory()) return null;
  return { names: names.filter((n) => physicalOf(n) === physical), physical };
}

/**
 * System temp roots for the command-output window: `/tmp` (and `/private/tmp`
 * where that is its physical location) plus the per-user `$TMPDIR` when it
 * is a macOS `/var/folders/x/y/T` dir. Files are only ever matched as direct
 * children, so no sub-directory, `..` or symlinked name is reachable.
 * @param tmpdir - `$TMPDIR` value (injectable for tests).
 * @returns The roots that exist as real directories.
 */
export function tempRoots(tmpdir: string | undefined = process.env.TMPDIR): TempRoot[] {
  const out: TempRoot[] = [];
  const fixed = resolveRoot(["/tmp", "/private/tmp"]);
  if (fixed) out.push(fixed);
  const user = tmpdir?.replace(/\/$/, "");
  if (user !== undefined && USER_TMP.test(user)) {
    const alt = user.startsWith("/private/") ? user.slice("/private".length) : `/private${user}`;
    const root = resolveRoot([user, alt]);
    if (root) out.push(root);
  }
  return out;
}

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

/**
 * @module motion/trust
 * Trust checks for the Motion store layout: the key directory, key files and the
 * `~/.fuse-harness` root. Every failure is a {@link MotionStoreError} naming the
 * real cause and the exact path the owner must fix, so callers can fail closed
 * for Motion work only and say why.
 */
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fuseHarnessHome } from "../../runtime/home-state";

/** A Motion store/keys layout problem; `path` is what the owner must fix. */
export class MotionStoreError extends Error {
  /** Underlying errno code when the failure came from a syscall (keeps native-denial routing intact). */
  code?: string;
  constructor(message: string, readonly path: string, readonly scoped: boolean = false, code?: string) {
    super(`${message} Fix: ${path}`);
    this.name = "MotionStoreError";
    if (code) this.code = code;
  }
}

const uid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** lstat that never follows links; `null` when absent. */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  // ENOTDIR: a parent is a regular file (the store readers already treat that as "no data").
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "ENOENT" || code === "ENOTDIR") return null; throw error; }
}

/**
 * Trust check for the private key directory: a real directory (no symlink), owned by this user,
 * with group/other bits tightened to 0o700. Absent is fine (created later by the grant path).
 * @param dir - `~/.fuse-harness/video-motion/keys`.
 */
export function assertTrustedKeyDir(dir: string, scoped: boolean = true): void {
  const info = lstatOrNull(dir);
  if (!info) return;
  const me = uid();
  if (info.isSymbolicLink() || !info.isDirectory()) throw new MotionStoreError(`Motion key directory ${dir} is a symlink or not a directory; refusing to read or write keys through it.`, dir, scoped);
  if (me !== null && info.uid !== me) throw new MotionStoreError(`Motion key directory ${dir} is not owned by this user; refusing to use it.`, dir, scoped);
  if ((Number(info.mode) & 0o077) !== 0) {
    try { chmodSync(dir, 0o700); }
    catch { throw new MotionStoreError(`Motion key directory ${dir} is accessible to group/others and could not be tightened to 0700.`, dir, scoped); }
  }
}

/**
 * A symlinked `~/.fuse-harness` is tolerated only when its target stays inside the OS home and is owned
 * by this user; a plain directory (or an absent one) is left as is.
 * @param base - `~/.fuse-harness`.
 * @param home - OS home it must resolve under.
 */
export function assertTrustedHarnessRoot(base: string, home: string): void {
  const info = lstatOrNull(base);
  if (!info || !info.isSymbolicLink()) return;
  const me = uid();
  let target: string, realHome: string;
  try { target = realpathSync(base); realHome = realpathSync(home); }
  catch { throw new MotionStoreError(`Motion harness root ${base} is a dangling symlink.`, base); }
  const inside = target === realHome || target.startsWith(realHome.endsWith(sep) ? realHome : realHome + sep);
  const owner = lstatOrNull(target);
  if (!inside || !owner || (me !== null && owner.uid !== me)) {
    throw new MotionStoreError(`Motion harness root ${base} is a symlink to ${target}, outside the home or owned by another user; refusing to use it.`, base);
  }
}

/** Path of the key directory without triggering the migration (guards must never throw on a broken store). */
export function plainKeyDirectory(home: string): string {
  return join(fuseHarnessHome(home), "video-motion", "keys");
}

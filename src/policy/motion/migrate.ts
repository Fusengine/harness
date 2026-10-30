/**
 * @module motion/migrate
 * One-shot, race-safe move of the pre-relocation Motion data
 * (`~/.fuse-harness/motion/` store, `~/.fuse-harness/motion-keys/` keys) into
 * `~/.fuse-harness/video-motion/` (store contents) and `video-motion/keys/`.
 * Only `rename(2)` is used: contents and modes are preserved byte for byte and
 * nothing is ever deleted or overwritten. Soft errors (ENOENT/EEXIST/ENOTEMPTY)
 * mean another process already did the work or the destination is taken.
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fuseHarnessHome } from "../../runtime/home-state";
import { MotionStoreError, assertTrustedHarnessRoot, assertTrustedKeyDir } from "./trust";

/** Homes already handled by this process (the move is idempotent, this only saves syscalls). */
const done = new Set<string>();
const SOFT = new Set(["ENOENT", "EEXIST", "ENOTEMPTY", "ENOTDIR"]);

/** lstat that never follows links; `null` when absent. */
function stat(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** rename(2) that treats the soft races as "not moved". */
function tryRename(from: string, to: string): boolean {
  try { renameSync(from, to); return true; }
  catch (error) { if (SOFT.has((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

/** Create a private directory unless it exists; refuses a symlink or a non-directory at that path. */
function ensurePrivateDir(path: string): boolean {
  const existing = stat(path);
  if (existing) return existing.isDirectory() && !existing.isSymbolicLink();
  try { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const created = stat(path);
  return !!created && created.isDirectory() && !created.isSymbolicLink();
}

/** Move `from` to `to`; when `to` is already taken, move only the children `to` does not have. */
function moveDirectory(from: string, to: string): void {
  const source = stat(from);
  if (!source || !source.isDirectory() || source.isSymbolicLink()) return;
  if (!stat(to) && tryRename(from, to)) return;
  if (!ensurePrivateDir(to)) return;
  let names: string[];
  try { names = readdirSync(from); }
  catch (error) { if (SOFT.has((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
  for (const name of names) {
    if (!stat(join(to, name))) tryRename(join(from, name), join(to, name));
  }
}

/**
 * Relocate the old Motion store and keys. No-op when neither old directory exists;
 * when both old and new exist the new one wins and the old one is left in place
 * (still protected by the legacy fragment).
 * @param home - OS home.
 */
export function migrateMotionData(home: string): void {
  if (done.has(home)) return;
  const base = fuseHarnessHome(home);
  const oldStore = join(base, "motion");
  const oldKeys = join(base, "motion-keys");
  const root = join(base, "video-motion");
  const keys = join(root, "keys");
  try {
    assertTrustedHarnessRoot(base, home);
    assertTrustedKeyDir(keys, false);
    if (stat(oldStore) || stat(oldKeys)) {
      moveDirectory(oldStore, root);
      if (stat(oldKeys) && ensurePrivateDir(root)) moveDirectory(oldKeys, keys);
    }
    assertTrustedRoot(root);
    assertTrustedKeyDir(keys, false);
  } catch (error) {
    if (error instanceof MotionStoreError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new MotionStoreError(`Motion data migration failed (${error instanceof Error ? error.message : String(error)}).`, base, false, code);
  }
  assertNoKeyConflict(oldKeys, keys);
  done.add(home);
}

/** Fail closed when the Motion root is a symlink, not a directory, not ours, or writable by group/others (planted before first use). */
function assertTrustedRoot(root: string): void {
  const info = stat(root);
  if (!info) return;
  const foreign = typeof process.getuid === "function" && info.uid !== process.getuid();
  // A regular file at the root cannot host data; the store readers already treat it as "no approval".
  if (info.isSymbolicLink() || foreign || (info.isDirectory() && (Number(info.mode) & 0o022) !== 0)) {
    throw new MotionStoreError(`Motion root ${root} is a symlink, not owned by this user or writable by others; refusing to use it.`, root);
  }
}

/** A same-name key differs between the old and the new key directory (downgrade/re-upgrade leftover); the new one stays authoritative. */
export class MotionKeyConflictError extends Error {
  constructor(readonly keyName: string, readonly oldKeys: string) {
    super(`Motion key ${keyName} exists with different content in the old and the new key directory; the new one is authoritative`);
  }
}

/** Throw {@link MotionKeyConflictError} when a leftover old key and a new key share a name but differ. */
function assertNoKeyConflict(oldKeys: string, newKeys: string): void {
  const old = stat(oldKeys);
  if (!old || !old.isDirectory() || old.isSymbolicLink() || !stat(newKeys)) return;
  for (const name of readdirSync(oldKeys)) {
    const a = stat(join(oldKeys, name)), b = stat(join(newKeys, name));
    if (!name.endsWith(".key") || !a || !b || !a.isFile() || !b.isFile()) continue;
    if (!readFileSync(join(oldKeys, name)).equals(readFileSync(join(newKeys, name)))) throw new MotionKeyConflictError(name, oldKeys);
  }
}

/** Forget the per-process memo (tests that rebuild a home between resolves). */
export function resetMotionMigrationMemo(): void {
  done.clear();
}

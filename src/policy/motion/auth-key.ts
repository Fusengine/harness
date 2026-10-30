/** @module motion/auth-key — private per-project signing keys, never returned as context. */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, linkSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { motionKeyDirectory, motionKeyPath } from "./store";
import { assertTrustedKeyDir } from "./trust";

/** Read a private regular 32-byte key; missing, linked, oversized or permissive keys fail closed. */
export function readMotionKey(root: string, home: string): Buffer | null {
  let fd: number | undefined;
  assertTrustedKeyDir(motionKeyDirectory(home));
  try {
    fd = openSync(motionKeyPath(root, home), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    const key = Buffer.alloc(32);
    return readSync(fd, key, 0, 32, 0) === 32 ? key : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Publish only a fully written private key via exclusive hard-link creation; concurrent grants share the winner. */
export function grantingMotionKey(root: string, home: string): Buffer | null {
  let fd: number | undefined;
  const target = motionKeyPath(root, home), temporary = `${target}.${randomUUID()}.tmp`;
  assertTrustedKeyDir(motionKeyDirectory(home));
  try {
    const existing = readMotionKey(root, home);
    if (existing) return existing;
    mkdirSync(motionKeyDirectory(home), { recursive: true, mode: 0o700 });
    assertTrustedKeyDir(motionKeyDirectory(home));
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, 0o600);
    const key = randomBytes(32);
    if (writeSync(fd, key, 0, key.length, 0) !== key.length) return null;
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(temporary, target); }
    catch { return readMotionKey(root, home); }
  } catch { return null; }
  finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* crash leftovers never occupy the authoritative key path */ }
  }
  return readMotionKey(root, home);
}

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { isFreshOrRegular } from "./bash-write-scratchpad-target";

/** Working directory as far as the command's own `cd` statements define it: none yet, a known absolute dir, or unknowable. */
export type Cwd = { kind: "none" } | { kind: "dir"; path: string } | { kind: "unknown" };

/** The cwd before any `cd` runs. */
export const NO_CWD: Cwd = { kind: "none" };

/** True when `path` is, or lives below, a pseudo-filesystem the Write tool cannot create files in (devices, procfs, sysfs). */
function inSpecialFs(path: string): boolean {
  return ["/dev", "/proc", "/sys"].some((root) => path === root || path.startsWith(`${root}/`));
}

/** Physical path of an existing directory (symlinks resolved), null when it is absent, not a directory or unreadable. */
function physicalDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Cwd after a `cd <arg>` statement: a plain, normalized absolute directory
 * that really exists (symlinks resolved) is tracked; anything else (relative,
 * `..`, `-`, no argument, a missing dir or a file) makes the cwd unknowable
 * for the rest of the command.
 * @param arg - The single argument of `cd`, if any.
 * @returns The tracked directory, or `{ kind: "unknown" }` when it cannot be resolved statically.
 */
export function cwdAfterCd(arg: string | undefined): Cwd {
  if (arg === undefined || !isAbsolute(arg) || normalize(arg) !== arg.replace(/(.)\/$/, "$1")) return { kind: "unknown" };
  const path = physicalDir(arg);
  return path === null ? { kind: "unknown" } : { kind: "dir", path };
}

/**
 * Whether `target` is certainly an ordinary file the Write tool could create
 * or overwrite. Allowlist: the target resolves to one absolute path whose
 * parent directory physically exists outside `/dev`, `/proc`, `/sys`, and the
 * path itself is either absent (fresh name) or a single-link regular file.
 * A symlink, device, FIFO, socket, directory, hard-linked file, `..` segment,
 * non-normalized spelling, missing parent or unresolvable cwd is never ordinary.
 * Relative targets resolve against the tracked `cd` dir, else the payload cwd.
 * @param target - Redirect / tee target as written.
 * @param cwd - Cwd tracked from the preceding `cd` statements.
 * @param payloadCwd - Absolute cwd of the host payload (where the shell starts); undefined when unknown.
 * @returns True only when the target is provably an ordinary file path.
 */
export function isOrdinaryFileTarget(target: string, cwd: Cwd, payloadCwd?: string): boolean {
  // A leading `=` is zsh command-path expansion (`=ls` -> /bin/ls): the word is not the file it spells.
  if (target === "" || target.startsWith("=") || target.endsWith("/") || target.split("/").includes("..")) return false;
  let path: string;
  if (isAbsolute(target)) {
    if (normalize(target) !== target) return false;
    path = target;
  } else {
    const base = cwd.kind === "dir" ? cwd.path : cwd.kind === "none" ? payloadCwd : undefined;
    if (base === undefined || !isAbsolute(base)) return false;
    path = join(base, target);
  }
  const parent = physicalDir(dirname(path));
  if (parent === null || inSpecialFs(parent)) return false;
  return isFreshOrRegular(parent, basename(path));
}

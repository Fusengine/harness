import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { CODE_EXT } from "./bash-write-patterns";

/** A code-file NAME (anchored: `x.ts.orig` and `notes.c-draft.txt` are not code). */
export const CODE_NAME: RegExp = new RegExp(`\\.(?:${CODE_EXT})$`, "i");
/** Glob characters of a source word. */
export const GLOB: RegExp = /[*?[]/;
/** Files whose presence in a directory marks it as a project root when there is no git checkout. */
export const MANIFESTS: readonly string[] = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml", "composer.json", "Package.swift", "deno.json"];

/** Real path of `p`, following symlinks as far as it exists (a missing tail is appended unresolved). */
export function realish(p: string): string {
  const tail: string[] = [];
  let at = p;
  for (;;) {
    try { return join(realpathSync(at), ...tail.reverse()); } catch { /* climb */ }
    const up = dirname(at);
    if (up === at) return p;
    tail.push(basename(at));
    at = up;
  }
}

/**
 * The PROVEN project root of a payload cwd: the hardened git top-level (symlinks resolved); failing that,
 * the nearest ancestor holding a project manifest ({@link MANIFESTS}); failing that, null (no root: nothing
 * can be judged "outside the project").
 * @param cwd - Absolute cwd of the host payload.
 */
export function provenRoot(cwd: string | null): string | null {
  if (cwd === null) return null;
  try {
    // Hardened: a checkout's own config (fsmonitor, hooks) must never run from a guard.
    const top = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
    if (top) return realish(top);
  } catch { /* not a git checkout */ }
  let dir = realish(cwd);
  for (;;) {
    if (MANIFESTS.some((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** True when `p` names an existing directory. */
export const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Where relative paths resolve (null = unknown), the payload cwd, the lazily resolved proven root, and the session scratchpad. */
export interface CpContext {
  from: string | null;
  cwd: string | null;
  root: () => string | null;
  scratch?: string;
  /** Proven root per directory, shared by every command of one scan (one `git rev-parse` per directory). */
  roots?: Map<string, string | null>;
}

const within = (base: string, p: string): boolean => {
  const rel = relative(base, p);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};

/** True when the real path of `p` is inside the project: the proven root, or (no root) the payload cwd. */
export function inProject(ctx: CpContext, p: string): boolean {
  const base = ctx.root() ?? (ctx.cwd === null ? null : realish(ctx.cwd));
  return base !== null && within(base, realish(p));
}

/** True when `p` is outside a PROVEN project root (never true without a root). */
export function outsideProven(ctx: CpContext, p: string): boolean {
  const root = ctx.root();
  return root !== null && !within(root, realish(p));
}

/**
 * The context to judge ONE destination in: its proven root is that of the nearest existing directory of
 * `dstAbs` ({@link provenRoot}: hardened git top-level, else nearest manifest), cached per directory. When that
 * directory has no provable root the payload cwd's root stands, so the verdict is the one the payload cwd gives.
 * @param ctx - Context of the whole command (its `root()` is the payload cwd's root).
 * @param dstAbs - Absolute destination path (null: unknown, the context is returned unchanged).
 */
export function destContext(ctx: CpContext, dstAbs: string | null): CpContext {
  const own = dstAbs === null ? null : ownRoot(ctx, dstAbs);
  return own === null ? ctx : { ...ctx, root: () => own };
}

/** Proven root of the nearest existing directory of `p` (null: none provable), cached per directory in `ctx.roots`. */
export function ownRoot(ctx: CpContext, p: string): string | null {
  let dir = realish(p);
  while (!isDir(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const cache = ctx.roots ?? new Map<string, string | null>();
  if (!cache.has(dir)) cache.set(dir, provenRoot(dir));
  return cache.get(dir) ?? null;
}

/** True when `p` is under a temp or scratchpad directory (and not inside the project itself). */
export function isTemp(ctx: CpContext, p: string): boolean {
  const real = realish(p);
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", realish(tmpdir()), ...(ctx.scratch ? [ctx.scratch] : [])];
  return !inProject(ctx, p) && roots.some((r) => within(r, real) || within(realish(r), real));
}

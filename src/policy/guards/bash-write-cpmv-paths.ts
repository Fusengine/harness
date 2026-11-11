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

/** True when `p` is under a temp or scratchpad directory (and not inside the project itself). */
export function isTemp(ctx: CpContext, p: string): boolean {
  const real = realish(p);
  const roots = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", realish(tmpdir()), ...(ctx.scratch ? [ctx.scratch] : [])];
  return !inProject(ctx, p) && roots.some((r) => within(r, real) || within(realish(r), real));
}

/**
 * @module inject-session/loader-child
 * Detects the second copy of a hook: the owner's `settings.json` registers
 * `hooks-loader.ts <Event>`, which spawns every plugin's hook command itself
 * (hook-executor.ts) and merges all outputs into ONE string, while the same
 * plugins also run natively. The loader's children carry no distinguishing
 * env var, but their parent process is the loader — so the parent command line
 * (`ps -o command= -p <ppid>`) tells them apart. Unknown/unreadable parent is
 * treated as the loader copy: the safe direction (it never claims).
 */
import { spawnSync } from "node:child_process";

/** Env key carrying a rendezvous registration's loader-vs-native answer from the registering process to the leader that serves it. */
export const LOADER_ENV = "FUSE_HARNESS_LOADER_COPY";

let memo: boolean | undefined;

/**
 * The env a rendezvous registration is written with. For Claude Code the
 * answer of THIS (registering) process is stamped in, because the leader that
 * later runs the registration in its own process cannot know it (its parent
 * is a different process). Other hosts: `env` unchanged.
 * @param id - Harness target id.
 * @param env - The process env snapshot.
 * @returns `env`, plus {@link LOADER_ENV} for `claude-code`.
 */
export function registrationEnv(id: string, env: Record<string, string>): Record<string, string> {
  return id === "claude-code" ? { ...env, [LOADER_ENV]: isLoaderChild() ? "1" : "0" } : env;
}

/**
 * Is `cmd` the command line of the hooks-loader dispatcher?
 * @param cmd - Parent process command line.
 * @returns True for `.../hooks-loader.ts <Event>`.
 */
export function isLoaderCommand(cmd: string): boolean {
  return /(^|[\s/])hooks-loader\.(ts|js|mjs)(\s|$)/.test(cmd);
}

/**
 * Is this hook process a child of the hooks-loader (the duplicate copy)?
 * Memoized per process; fails safe (true) when the parent cannot be read.
 * @returns True when the parent is the loader or cannot be determined.
 */
export function isLoaderChild(): boolean {
  // A registration served inside a rendezvous leader carries its OWN process's answer (see registrationEnv): the leader's parent says nothing about it.
  const carried = process.env[LOADER_ENV];
  if (carried === "1") return true;
  if (carried === "0") return false;
  if (memo !== undefined) return memo;
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf-8", timeout: 2000 });
    const cmd = (r.stdout ?? "").trim();
    memo = r.status !== 0 || cmd === "" ? true : isLoaderCommand(cmd);
  } catch {
    memo = true;
  }
  return memo;
}

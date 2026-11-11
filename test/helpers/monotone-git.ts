import { execFileSync } from "node:child_process";

/**
 * `git init` for a throwaway test checkout, hardened so no repository config can run anything:
 * fsmonitor off, hooks path /dev/null, no system/global config, a timeout, a minimal environment.
 * @param dir - Directory to initialise (created by the caller, under the OS temp dir).
 */
export function safeGitInit(dir: string): void {
  execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "init", "-q", dir], {
    stdio: "ignore",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

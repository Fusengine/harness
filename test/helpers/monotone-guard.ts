import { bashWriteGuard } from "../../src/policy/guards/bash-write";
import type { Verdict } from "./monotone-verdict";

/**
 * Verdict of the bare Bash-write guard alone (no hook chain) for one command run from `cwd`.
 * @param command - Raw Bash command text.
 * @param cwd - Payload cwd the guard resolves relative paths against.
 */
export function guardVerdict(command: string, cwd: string): Verdict {
  const r = bashWriteGuard({ tool: "Bash", command, cwd });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

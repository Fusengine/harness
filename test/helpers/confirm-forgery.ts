import { approvalForgeryViolation } from "../../src/policy/motion/forgery";

/**
 * `"block"` when the forgery guard refuses this Bash command, else `"allow"`.
 * @param command - The Bash command under judgment.
 */
export function forgeryOf(command: string): "block" | "allow" {
  return approvalForgeryViolation("Bash", command, { command })?.kind === "block" ? "block" : "allow";
}

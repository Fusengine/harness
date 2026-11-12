import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";

const PATH = "(?:[^\\s|;&]*/)?";
/** `ssh … | [sudo] sh|bash|zsh`, matched on the command with quoted text blanked (a `| sh` inside the quoted remote command runs remotely). */
const SSH_PIPED_TO_SHELL: RegExp = new RegExp(
  `(?:^\\s*|[;&|(\\n]\\s*)${PATH}ssh\\s(?:[^;&|\\n]|[0-9]*>&[0-9]+)*\\|&?\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?${PATH}(?:sh|bash|zsh)(?=[\\s;&|)<>]|$)`,
);

/**
 * Asks for confirmation when ssh output is piped straight into a local shell (`ssh … | sh`, `| bash`, `| zsh`, optionally with
 * `sudo`). It only ever ADDS an ask: `evaluate()` consults it last and only when every other policy would allow, so a block or an
 * earlier ask is never replaced.
 * @param ctx - Guard context (Bash command).
 */
export function sshToShellGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  if (!SSH_PIPED_TO_SHELL.test(ctx.command.replace(/'[^']*'|"[^"]*"/g, "''"))) return null;
  return {
    kind: "ask",
    title: "Remote output executed locally",
    reason: `remote output executed by the local shell: ${ctx.command.trim()}`,
    actions: ["Confirm the remote output is meant to run on this machine"],
  };
}

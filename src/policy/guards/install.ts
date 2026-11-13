import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { matchPatterns, PROJECT_INSTALL, SYSTEM_INSTALL, isRalphMode } from "../patterns";
import { remoteLocalView } from "../remote-target";

/**
 * Asks for confirmation before a dependency or system package install. In Ralph
 * mode (opt-in `RALPH_MODE`) a PROJECT install is auto-approved for autonomous
 * runs (parity install-guard.py:52), but a SYSTEM install always asks.
 */
export function installGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  // A PROVEN-remote `ssh host '…'` payload installs on that machine, not here: judge only the local part.
  const judged: string = remoteLocalView(ctx.command) ?? ctx.command;
  const isSystem = matchPatterns(judged, SYSTEM_INSTALL);
  const isProject = matchPatterns(judged, PROJECT_INSTALL);
  if (!isSystem && !isProject) return null;
  if (!isSystem && isProject && isRalphMode()) return null;
  return {
    kind: "ask",
    title: "Dependency install",
    reason: `This command installs packages: ${ctx.command.trim()}`,
    actions: ["Confirm this install is intended"],
  };
}

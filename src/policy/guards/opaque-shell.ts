import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { expand } from "../effective-segments";

/**
 * Fail-closed ask for a command line whose real commands cannot be read
 * statically (`sh -c "$CMD"`, `$CMD args`, `{git,push}`, `${IFS}` splitting, a
 * git alias, nesting past the analysis budget). Runs LAST in the chain, so it
 * only fires when no other guard has a verdict: it can never replace a block.
 * @param ctx - Guard context.
 */
export function opaqueShellGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command || !expand(ctx.command).opaque) return null;
  return {
    kind: "ask",
    ruleId: "opaque-shell",
    title: "Command cannot be analysed",
    reason: "DANGEROUS PATTERN: a command or shell payload is built at run time (cannot be analysed).",
    actions: ["Confirm this command is intended", "Write the command out literally"],
  };
}

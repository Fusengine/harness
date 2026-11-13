import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { confirmRelayViolation } from "../confirm-relay";

/**
 * Block an agent that relays a `CONFIRM <code>` through a nested agent CLI
 * (`codex exec resume … 'CONFIRM ab12'`, `kimi -p 'CONFIRM ab12'`): the code
 * arms an rm/git ask and only the owner may type it in their own session. The
 * detection lives in `policy/confirm-relay.ts`; this guard puts it on the core
 * path every host wires (Claude Code, Codex, Kimi, Cursor).
 * @param ctx - Guard context.
 */
export function confirmRelayGuard(ctx: GuardContext): Prompt | null {
  return confirmRelayViolation(ctx.tool, ctx.command);
}

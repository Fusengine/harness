/**
 * @module inject-session/apply
 * Wiring of {@link module:inject-session/filter} into the Claude Code hook
 * exit: resolves the state dir / home the same way the rest of the runtime
 * does (test-only `home` override honoured) and filters a successful outcome.
 */
import { homedir } from "node:os";
import type { HandleOptions, HandleOutcome } from "../handle-types";
import { filterClaudeContext } from "./filter";
import { injectStateDir } from "./registry";
import { isLoaderChild } from "./loader-child";
import { loaderOrder, loaderOwnership } from "./ownership";

/** Max ms a native-backed loader child waits for the scopes before it in the loader's merge order to record their block length. */
const SETTLE_MS = 400;

/**
 * Run a Claude Code hook outcome through the once-per-session registry.
 * Non-zero exits and every non-injecting event pass through unchanged.
 * @param outcome - What {@link module:runtime/handle.handleHook} computed.
 * @param payload - The raw hook payload.
 * @param opts - Handle options (cwd, clock, optional home override).
 * @returns The outcome with `stdout` reduced to the context the model has not received yet.
 */
export function applySessionRegistry(outcome: HandleOutcome, payload: Record<string, unknown>, opts: HandleOptions): HandleOutcome {
  // Only a real Claude Code hook process is filtered: it exports CLAUDE_PROJECT_DIR (documented, stable for the whole session). Synthetic replays do not.
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (outcome.exit !== 0 || !proj) return outcome;
  const home = opts.home ?? homedir();
  const ownership = (event: string, scope: string, tool?: string) => loaderOwnership(home, proj, event, scope, tool);
  const stdout = filterClaudeContext(outcome.stdout, { payload, stateDir: injectStateDir(opts.cwd, opts.home), home, now: opts.now, scope: opts.scope ?? "core", isLoaderChild, ownership, order: (event, agentType) => loaderOrder(home, event, agentType), settleMs: SETTLE_MS });
  return stdout === outcome.stdout ? outcome : { ...outcome, stdout };
}

import { homedir } from "node:os";
import { cleanupSession } from "./session-end";
import { validateTaskSolid } from "./task-completed";
import { projectStateDir } from "../project-state-dir";
import { notify } from "../notifications";

/**
 * Handle the core scope's `Stop` event — Codex parity. Codex never emits
 * `SessionEnd`/`TaskCompleted` (codex-plugins/docs/reference/hooks.md,
 * "Harness Runtime Limits": "lifecycle dispatch includes Claude-only names
 * such as TaskCompleted, PostToolUseFailure, and SessionEnd; Codex does not
 * emit those events") but its own hooks.json wires `Stop` to `hook codex
 * core`, and its own docs table defines `Stop` as "turn finishes — cleanup
 * and completion notification". Both ported behaviors collapse onto it here
 * rather than being invented anew: {@link cleanupSession} (normally
 * SessionEnd-only) for cleanup, {@link validateTaskSolid} (normally
 * TaskCompleted-only) for the SOLID/receipt completion check.
 *
 * Claude-side, this branch IS reached too: core-guards' Claude `Stop` hooks
 * run `hook claude-code core --sound stop` (sound only, `cli/hook-sound.ts`)
 * AND a plain `hook claude-code core`, which lands here (see
 * `plugins/core-guards/hooks/hooks.json` in claude-plugins).
 * @param payload - The raw Stop hook payload.
 * @param cwd - Project root (drives the state dir).
 * @param now - Clock.
 * @param id - Harness adapter id (defaults to "claude-code").
 * @returns The native hook stdout ("" when the session is clean).
 */
export function stopCore(payload: Record<string, unknown>, cwd: string, now: number, id: string = "claude-code"): string {
  cleanupSession(undefined, now);
  // Turn finished — voice the "stop" sound (fire-and-forget, fail-open: never
  // throws, never blocks; a silent no-op when opted out or no sound resolves).
  notify("stop");
  return validateTaskSolid(payload, homedir(), now, projectStateDir(cwd), "Stop", id);
}

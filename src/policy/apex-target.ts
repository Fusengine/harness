/**
 * Harness-target helpers for the APEX context builders. Single source of
 * truth for the home-dir segment / root doc name / plan-tool idiom that
 * differ between Claude Code and Codex (and beyond), so the builders in
 * `claude-md-context.ts`, `apex-task-context.ts`, and `inject-apex.ts` never
 * hardcode `.claude`/`CLAUDE.md`/`TaskCreate` again. Runtime `id` values flow
 * through the pipeline as plain `string` (see `handleHook(id: string, ...)`),
 * so these helpers accept `string` and narrow internally — same idiom as the
 * existing `HOME_DIR[id] ?? ".claude"` precedent in `cartographer/detect.ts`.
 */
import { HOME_DIR } from "../config/dotenv";
import type { HarnessId } from "../detect/interfaces/types";

/**
 * Home-dir segment for a harness target (".claude", ".codex", ...). Falls
 * back to ".claude" for any harness without a {@link HOME_DIR} entry.
 * @param id - Harness id (e.g. "claude-code", "codex").
 * @returns The home-dir segment, e.g. ".claude".
 */
export function harnessHomeSegment(id: string): string {
  return HOME_DIR[id as HarnessId] ?? ".claude";
}

/**
 * THE per-host table of the root instructions doc (single source for
 * {@link apexDocName} and {@link hostRulesRef}). Claude Code reads `CLAUDE.md`;
 * Codex (`~/.codex/AGENTS.md`) and Kimi Code CLI (`~/.kimi-code/AGENTS.md`) read
 * `AGENTS.md` (documented conventions). Hosts absent here have no proven global
 * rules doc: Cursor's global rules are `~/.cursor/rules/*.mdc`, and its
 * `AGENTS.md` is only read at a workspace root (cursor-plugins
 * docs/reference/responsibility-parity.md, Cursor 3.18.25).
 */
const HOST_RULES_DOC: Readonly<Record<string, string>> = { "claude-code": "CLAUDE.md", codex: "AGENTS.md", kimi: "AGENTS.md" };

/**
 * Root instructions doc name the harness READS for a harness target: the
 * {@link HOST_RULES_DOC} entry, else "CLAUDE.md" (the harness's internal
 * injection filename for hosts without a proven doc: never cited to the model
 * as that host's rules, see {@link hostRulesRef}).
 * @param id - Harness id.
 * @returns The doc file name.
 */
export function apexDocName(id: string): string {
  return HOST_RULES_DOC[id] ?? "CLAUDE.md";
}

/**
 * How a model-facing message names a fuse-ai-pilot agent for this host: Claude
 * Code addresses plugin agents as `fuse-ai-pilot:<name>`; every other host
 * (Codex `~/.codex/agents/<name>.toml`, Kimi, Cursor `agents/<name>.md`)
 * registers the bare `<name>`, so the Claude-only prefix is never shown there.
 * @param id - Harness id (defaults to Claude Code).
 * @param name - Bare agent name (e.g. "sniper").
 * @returns The host's own reference to that agent.
 */
export function hostAgentRef(id: string, name: string): string {
  return id === "claude-code" ? `fuse-ai-pilot:${name}` : name;
}

/**
 * The project-rules doc to cite in a mandatory-rule sentence: `CLAUDE.md` on
 * Claude Code, `AGENTS.md` on Codex and Kimi, and neutral wording elsewhere
 * (a host whose rules file cannot be proven is never given a Claude name).
 * @param id - Harness id.
 * @returns E.g. "CLAUDE.md rules" or "your project rules".
 */
export function hostRulesRef(id: string): string {
  const doc = HOST_RULES_DOC[id];
  return doc ? `${doc} rules` : "your project rules";
}

/**
 * Native plan/track tool name for a harness target: Codex's `update_plan`,
 * Kimi Code CLI's `TodoList`, or Claude's `TaskCreate` (default). Covers only
 * the PLAN-step line — other target-specific tool references (`TaskList`,
 * `TaskUpdate`) are resolved via `apexTaskSteps`/`apexAgentSteps` in
 * `apex-target-steps.ts` since their surrounding prose differs structurally,
 * not just by token.
 * @param id - Harness id.
 * @returns The plan-tool name.
 */
export function apexPlanTool(id: string): string {
  if (id === "codex") return "update_plan";
  if (id === "kimi") return "TodoList";
  return "TaskCreate";
}

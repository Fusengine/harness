import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveMaxLines, splitTarget } from "../config/limits";
import { DEV_KEYWORDS, type ProjectType } from "./detect-project";
import { getExpertAgent } from "./expert-agents";
import { apexDocName, harnessHomeSegment } from "./apex-target";
import { apexPlanPhrase } from "./apex-target-steps";
import { detectClaudeMdProjectType } from "./detect-claude-md-project-type";

export { detectClaudeMdProjectType };

/** Dev-verb regex (FR/EN) that triggers the APEX preamble (case-insensitive). */
export const DEV_VERBS: RegExp =
  /(cr[ée]er|impl[ée]menter|ajouter|d[ée]velopper|construire|build|refactor|migrer|implement|create|add|develop)/i;

/**
 * Build the APEX instruction preamble for a development task.
 * @param projectType - Detected project type label.
 * @param maxLines - SOLID per-file line ceiling.
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The APEX instruction text.
 */
export function buildApexInstruction(projectType: ProjectType, maxLines: number, id: string = "claude-code"): string {
  const expertAgent = getExpertAgent(projectType);
  const seg = harnessHomeSegment(id);
  const plan = apexPlanPhrase(id);
  return (
    `INSTRUCTION: This is a development task. Use APEX methodology:\n\n` +
    `**TRACKING FILE**: [project]/${seg}/apex/task.json — \`${seg}/apex/\` is harness-managed and read-only for agents\n\n` +
    `1. **ANALYZE** (MANDATORY - 3 AGENTS IN PARALLEL):\n` +
    `   - explore-codebase + research-expert + ${expertAgent} (framework expertise)\n` +
    `   - Project type detected: ${projectType}\n\n` +
    `2. **PLAN**: ${plan} (<${maxLines} lines per file)\n\n` +
    `3. **EXECUTE**: ${expertAgent}, follow SOLID principles, split at ${splitTarget(maxLines)} lines\n\n` +
    `4. **eLICIT**: self-review with NAMED elicitation techniques (apex ref 03.5-elicit) — fix findings BEFORE validation\n\n` +
    `5. **VERIFY**: functional check — run it, confirm references⇔declarations consistency\n\n` +
    `6. **eXAMINE**: Run sniper agent after ANY modification\n\n` +
    `**GATE**: eLicit + Verify BEFORE sniper — NEVER skip.\n\n` +
    `**IMPORTANT**: Read ${seg}/apex/task.json to check documentation status before writing code.`
  );
}

/**
 * Build the UserPromptSubmit injection text: read the target's root
 * instructions doc (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, ...) and,
 * when the prompt matches a dev verb, prepend the APEX instruction. Returns
 * `null` when the doc is absent/unreadable (the hook then emits nothing).
 * @param prompt - The raw user prompt.
 * @param cwd - Project root (for project-type detection).
 * @param id - Harness target id (defaults to "claude-code" — zero-regression default).
 * @returns The injection text, or `null` to emit nothing.
 */
export function buildClaudeMdContext(prompt: string, cwd: string, id: string = "claude-code"): string | null {
  const docName = apexDocName(id);
  const claudeMd = join(homedir(), harnessHomeSegment(id), docName);
  if (!existsSync(claudeMd)) return null;
  let claudeContent: string;
  try {
    claudeContent = readFileSync(claudeMd, "utf-8");
  } catch {
    return null;
  }
  if (!DEV_VERBS.test(prompt) && !DEV_KEYWORDS.test(prompt)) return `# ${docName}\n${claudeContent}`;
  const apex = buildApexInstruction(detectClaudeMdProjectType(cwd), resolveMaxLines(), id);
  return `${apex}\n\n# ${docName}\n${claudeContent}`;
}

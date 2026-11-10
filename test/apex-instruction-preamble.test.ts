import { test, expect } from "bun:test";
import { buildApexInstruction } from "../src/policy/claude-md-context";
import { getExpertAgent } from "../src/policy/expert-agents";

/**
 * Locks the 6-phase APEX preamble (Analyze-Plan-Execute-eLicit-Verify-eXamine)
 * and the honest tracking-file line — split out of inject-context.test.ts so
 * that file stays under the 100-line SOLID ceiling.
 */
test("buildApexInstruction: exact APEX preamble text (6 phases + honest tracking file)", () => {
  const out = buildApexInstruction("nextjs", 100);
  const agent = getExpertAgent("nextjs");
  expect(out.startsWith("INSTRUCTION: This is a development task. Use APEX methodology:")).toBe(true);
  for (const frag of [
    "**TRACKING FILE**: [project]/.claude/apex/task.json — `.claude/apex/` is harness-managed and read-only for agents",
    "Project type detected: nextjs",
    `explore-codebase + research-expert + ${agent}`,
    "2. **PLAN**: Break the work down into tasks (<100 lines per file)",
    `3. **EXECUTE**: ${agent}, follow SOLID principles, split at 90 lines`,
    "4. **eLICIT**: self-review with NAMED elicitation techniques (apex ref 03.5-elicit) — fix findings BEFORE validation",
    "5. **VERIFY**: functional check — run it, confirm references⇔declarations consistency",
    "6. **eXAMINE**: Run sniper agent after ANY modification",
    "**GATE**: eLicit + Verify BEFORE sniper — NEVER skip.",
  ]) expect(out).toContain(frag);
  expect(out.endsWith("**IMPORTANT**: Read .claude/apex/task.json to check documentation status before writing code.")).toBe(true);
});

test("buildApexInstruction: explicit id='claude-code' is byte-identical to the default (zero-regression)", () => {
  expect(buildApexInstruction("nextjs", 100, "claude-code")).toBe(buildApexInstruction("nextjs", 100));
});

test("buildApexInstruction: codex target uses .codex + update_plan, never .claude/TaskCreate", () => {
  const out = buildApexInstruction("nextjs", 100, "codex");
  expect(out.startsWith("INSTRUCTION: This is a development task. Use APEX methodology:")).toBe(true);
  for (const frag of [
    "**TRACKING FILE**: [project]/.codex/apex/task.json — `.codex/apex/` is harness-managed and read-only for agents",
    "2. **PLAN**: Use update_plan to break down tasks (<100 lines per file)",
  ]) expect(out).toContain(frag);
  expect(out.endsWith("**IMPORTANT**: Read .codex/apex/task.json to check documentation status before writing code.")).toBe(true);
  expect(out).not.toContain(".claude");
  expect(out).not.toContain("TaskCreate");
});

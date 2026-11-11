import { evaluate, type PolicyResult } from "../policy/evaluate";
import { protectedPathGate } from "../policy/trivial-edits";
import { existingLineCounts, isApexScoped } from "./gate-helpers";
import { FAIL_CLOSED } from "../policy/guards";
import { loadTrack } from "../tracking/store";
import { dryGate } from "./dry";
import { preCommitGate } from "./precommit";
import { modularGate } from "./modular";
import { frameworkSkillGate } from "./framework-skill-gate";
import { reconcileRefReadsFromTranscript } from "../freshness/ref-evidence";
import { reconcileRefReadsFromJournal } from "../freshness/ref-journal";
import { isShadcnWrite, shadcnSkillGate } from "../policy/shadcn-skill-gate";
import { isTailwindWrite, tailwindSkillGate } from "../policy/tailwind-skill-gate";
import { geminiMcpGate } from "../policy/gemini-mcp-gate";
import { apexScopedGate } from "./gate-apex";
import { withDenyLoop } from "./deny-loop-store";
import { recordOneShot } from "../tracking/one-shot";
import { dirname } from "node:path";
import type { GateInput } from "./gate-input";
import type { Prompt } from "../prompt/types";

export type { GateInput } from "./gate-input";

/** Prior agents the freshness gate requires before a code edit. */
export const REQUIRED_AGENTS: ReadonlyArray<string> = ["explore-codebase", "research-expert"];

/**
 * Default freshness window (ms). Matches the plugin's `FUSE_ENFORCE_TTL_SEC`
 * default (120s); only a fallback for callers that omit `windowMs` (e.g. tests) —
 * the real CLI path always supplies it from `resolveTtlSec()` (`src/config/ttl.ts`).
 */
export const DEFAULT_WINDOW_MS = 120_000;

/** Trivial edits allowed within the window before the full APEX gates apply. */
export const TRIVIAL_BUDGET = 4;

/**
 * Full gate: {@link runGates} yields the first blocking prompt (or null); the tail
 * records the one-shot metric ({@link recordOneShot}, observation-only) then lets
 * {@link withDenyLoop} rewrite an identical retried deny (decision unchanged).
 */
export async function gate(input: GateInput): Promise<Prompt | null> {
  const prompt = await runGates(input);
  return finalizeGate(input, prompt, input.command);
}

/**
 * Gate independent Cursor command candidates without merging their shell syntax.
 * Stateful outcome bookkeeping runs once, against the command that decided the
 * aggregate result. A single distinct candidate follows {@link gate} verbatim.
 */
export async function gateCommandCandidates(input: GateInput, candidates: readonly string[]): Promise<Prompt | null> {
  const distinct = [...new Set(candidates)];
  if (distinct.length <= 1) return gate(input);

  let decisive: { prompt: Prompt; command: string } | undefined;
  for (const command of distinct) {
    const prompt = await runGates({ ...input, command });
    if (!prompt) continue;
    if (!decisive || promptRank(prompt) > promptRank(decisive.prompt)) decisive = { prompt, command };
    if (prompt.kind === "block") break;
  }
  return finalizeGate(input, decisive?.prompt ?? null, decisive?.command ?? input.command);
}

/**
 * Persist one final gate outcome and apply deny-loop enrichment exactly once.
 * @param input - The gated tool-use (its `filePath`/`content` key the deny-loop op).
 * @param prompt - The decisive prompt, or null when every gate allowed.
 * @param command - The decisive shell command, if any.
 * @returns The prompt, possibly enriched as a repeated deny.
 */
export function finalizeGate(input: GateInput, prompt: Prompt | null, command: string | undefined): Prompt | null {
  const op = { filePath: input.filePath, content: input.content, command };
  const dir = dirname(input.trackFile);
  recordOneShot(prompt, op, { now: input.now, dir, sessionId: input.sessionId });
  return withDenyLoop(prompt, input.tool, op, { now: input.now, dir, windowMs: input.windowMs ?? DEFAULT_WINDOW_MS, sessionId: input.sessionId });
}

/** Higher numeric values dominate while equal values preserve wire order. */
function promptRank(prompt: Prompt): number {
  return prompt.kind === "block" ? 3 : prompt.kind === "ask" ? 2 : 1;
}

/**
 * Stateless guards, then the trivial fast path, then the stateful APEX gates.
 * @param input - The tool-use to gate.
 * @returns The first blocking prompt, or null when every gate allowed.
 */
export async function runGates(input: GateInput): Promise<Prompt | null> {
  // Pre-commit lint hard-block runs FIRST: evaluate()'s GIT_ASK branch would
  // otherwise short-circuit a `git commit` before the linters get to veto it.
  const precommit = preCommitGate(input.tool, input.command, input.cwd);
  if (precommit) return precommit;
  // Hook-managed paths: absolute deny on ALL extensions, BEFORE the code-ext/exempt filters (parity enforce-apex-phases.ts:48-52 — isApexScoped never routes a non-code/exempt path to the guard).
  const protectedDeny = protectedPathGate(input.tool, input.filePath);
  if (protectedDeny) return protectedDeny;
  const { raw: existingLines, code: existingCodeLines, content: existingContent } = existingLineCounts(input.filePath);
  let quick: PolicyResult;
  try {
    quick = evaluate({ tool: input.tool, filePath: input.filePath, content: input.content, command: input.command, scratchpadDir: input.scratchpadDir, cwd: input.payloadCwd, agentType: input.agentType, existingLines, existingContent, oldString: input.oldString, isReplaceAll: input.isReplaceAll, neverApproval: input.neverApproval });
  } catch {
    return FAIL_CLOSED;
  }
  if (quick.decision !== "allow" && quick.prompt) return quick.prompt;
  const modular = modularGate(input.tool, input.filePath, input.content, input.cwd);
  if (modular) return modular;
  if (!input.filePath) return null;
  return runFileGates(input, input.filePath, existingCodeLines);
}

/**
 * The file-keyed tail of {@link runGates}: framework/shadcn/Tailwind/Gemini skill
 * gates, the APEX-scoped gates, then DRY. Also run per file for a Codex
 * `apply_patch` (runtime/apply-patch-apex.ts), whose static gates already ran.
 * @param input - The tool-use to gate (`tool`/`content` of this one file).
 * @param filePath - The file being written.
 * @param existingCodeLines - On-disk code-line count of `filePath`, if it exists.
 * @param opts - `dry: false` skips the DRY grep when the caller already ran it.
 * @returns The first blocking prompt, or null when every gate allowed.
 */
export async function runFileGates(input: GateInput, filePath: string, existingCodeLines: number | undefined, opts: { dry?: boolean } = {}): Promise<Prompt | null> {
  // Reconcile refsRead BEFORE any consumer from two durable, race-immune sources (racy load→save loses lone
  // writes under the fan-out): the transcript restores the LEAD's flushed read, the append-only journal (ref-journal.ts) the TEAMMATE's un-flushed one (lag > TTL).
  const track = reconcileRefReadsFromJournal(
    reconcileRefReadsFromTranscript(await loadTrack(input.trackFile), input.transcriptPath, input.now, dirname(input.trackFile)),
    dirname(input.trackFile), input.now,
  );
  const solidOrSkill = frameworkSkillGate(input, track.refsRead, existingCodeLines);
  if (solidOrSkill) return solidOrSkill;
  // Standalone shadcn/ui gate (ports check-skill-loaded.py): runs independently of `framework` since a components.json / .css write may detect as "generic", mirroring the real plugin's own PreToolUse hook alongside react's.
  if (isShadcnWrite(input.tool, filePath)) {
    const shadcnBlock = shadcnSkillGate(input.tool, filePath, input.content ?? "", { refsRead: track.refsRead, authorizations: track.authorizations, sessionId: input.sessionId });
    if (shadcnBlock) return shadcnBlock;
  }
  // Standalone Tailwind base-skill gate (ports check-tailwind-skill.py Phase 1): a .tsx/.jsx write with Tailwind classes needs a base Tailwind skill read, independent of framework.
  if (isTailwindWrite(input.tool, filePath, input.content ?? "")) {
    const twBlock = tailwindSkillGate(input.tool, filePath, input.content ?? "", track.refsRead);
    if (twBlock) return twBlock;
  }
  // OPT-IN Gemini Design MCP gate (ports enforce-gemini-mcp.py) — a no-op unless FUSE_ENFORCE_GEMINI_MCP is set, then blocks hand-written Tailwind UI until a mcp__gemini-design__* call is made this session.
  const geminiBlock = geminiMcpGate(input.tool, filePath, input.content ?? "", { authorizations: track.authorizations, sessionId: input.sessionId });
  if (geminiBlock) return geminiBlock;
  // The freshness/doc/SOLID APEX gates only police code files (require-apex-agents.py parity): non-code and exempt paths skip straight to the DRY check below.
  if (isApexScoped(filePath)) {
    const apex = await apexScopedGate(input, track, input.windowMs ?? DEFAULT_WINDOW_MS);
    if (apex) return apex;
  }
  // DRY duplication (effectful: greps the codebase) — runs once the APEX gates pass.
  return opts.dry === false ? null : dryGate(input.tool, filePath, input.content, input.cwd);
}

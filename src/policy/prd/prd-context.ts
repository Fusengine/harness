/**
 * The SubagentStart "slice" text builder: renders only the sub-agent's own
 * PRD assignment, never the whole task. Pure — no fs.
 */
import { candidateAgentNames } from "./prd-ownership";
import { prdAgentReportPath } from "./prd-paths";
import { filesOf, subTasksOf } from "./prd-schema";
import type { PrdSubagentSlice, PrdTaskFile } from "./interfaces/types";

/**
 * Builds the slice of `taskFile` owned by each candidate name matching
 * `agentType` — one entry per candidate. Empty when no candidate matches;
 * 2+ entries when the match is ambiguous (shared base type, e.g.
 * `backend-expert`/`backend-expert-2`) so the caller can surface every
 * possibility instead of silently dropping the assignment.
 */
export function agentSlices(taskFile: PrdTaskFile, agentType: string, task: string): PrdSubagentSlice[] {
  const slices: PrdSubagentSlice[] = [];
  for (const agent of candidateAgentNames(agentType, taskFile)) {
    const entry = taskFile[agent];
    if (entry) slices.push({ task, agent, subTasks: Object.keys(subTasksOf(entry)), files: filesOf(entry) });
  }
  return slices;
}

/**
 * Builds the one slice of `taskFile` owned by `agentType`, or `null` when no
 * candidate matches, or the match is ambiguous (2+ candidates — see
 * {@link agentSlices} to get all of them instead).
 */
export function agentSlice(taskFile: PrdTaskFile, agentType: string, task: string): PrdSubagentSlice | null {
  const slices = agentSlices(taskFile, agentType, task);
  return slices.length === 1 ? (slices[0] ?? null) : null;
}

/** Where the host's PRD tree lives, so the slice can name the report path absolutely. */
export interface PrdSliceContext {
  /** Project root (`prdProjectRoot`). */
  root: string;
  /** Host home-dir segment (`harnessHomeSegment`), e.g. `.codex`. */
  homeSeg: string;
}

function reportLine(s: PrdSubagentSlice, ctx?: PrdSliceContext): string {
  if (!ctx) return `Report to prd/agents/${s.agent}-prd.json when done.`;
  return `Report to ${prdAgentReportPath(ctx.root, ctx.homeSeg, s.agent)} when done (absolute path — never <project>/prd/agents/).`;
}

function renderSliceBlock(s: PrdSubagentSlice, ctx?: PrdSliceContext): string {
  return [
    `## PRD assignment — task ${s.task}`,
    `Your files: ${s.files.join(", ")}`,
    `Your sub-tasks: ${s.subTasks.join(", ")}`,
    reportLine(s, ctx),
  ].join("\n");
}

/**
 * Renders one readable markdown block per slice: title, files, sub-tasks,
 * report path. When 2+ slices share the same `task` (an ambiguous
 * `agentSlices` result), prefixes that group with an explicit
 * disambiguation header instead of silently rendering as if unambiguous.
 * @param ctx - When given, the report path is rendered absolute (the host's real
 * `<root>/<homeSeg>/apex/prd/agents/…`); absent, the legacy relative text.
 */
export function renderAgentSliceMarkdown(slices: PrdSubagentSlice[], ctx?: PrdSliceContext): string {
  const byTask = new Map<string, PrdSubagentSlice[]>();
  for (const s of slices) {
    const group = byTask.get(s.task);
    if (group) group.push(s); else byTask.set(s.task, [s]);
  }

  const blocks: string[] = [];
  for (const group of byTask.values()) {
    if (group.length > 1) {
      const names = group.map((s) => s.agent).join(", ");
      blocks.push(
        `Several assignments match your agent type. You are ONE of: ${names}. `
        + "The first report you write binds your name; write only that report.",
      );
    }
    for (const s of group) blocks.push(renderSliceBlock(s, ctx));
  }
  return blocks.join("\n\n");
}

/** One rendered context part's extracted text, plus which envelope it came from. Local implementation detail — never exported (not part of the frozen `interfaces/types.ts` contract). */
interface ExtractedContext {
  text: string;
  /** true = cline's native `{contextModification}` shape (see `respond()`'s `"cline"` branch in `runtime/respond.ts`); false = the Claude-family `hookSpecificOutput.additionalContext` envelope every other target (including gemini-cli, which omits `hookEventName` but keeps this same key path) uses. */
  native: boolean;
}

/** True for a non-null JSON object `JSON.parse` can produce (excludes arrays/primitives/null). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extracts the text + originating shape from one already-rendered context
 * response (parse-then-narrow, no unchecked `as` cast on the parsed value —
 * see {@link isRecord}), or `null` when the input fails to parse, or parses
 * to neither known shape.
 */
function contextTextOf(response: string): ExtractedContext | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const hso = parsed.hookSpecificOutput;
  const claudeText = isRecord(hso) && typeof hso.additionalContext === "string" ? hso.additionalContext : "";
  if (claudeText) return { text: claudeText, native: false };
  const clineText = typeof parsed.contextModification === "string" ? parsed.contextModification : "";
  if (clineText) return { text: clineText, native: true };
  return null;
}

/**
 * Joins two already-rendered `contextResponse(...)`-shaped JSON strings into
 * one (same fold `dispatch-aipilot.ts`'s `combineContext` already does) —
 * kept local to avoid a 3rd import edge into that file.
 *
 * Recognizes BOTH the Claude-family `hookSpecificOutput.additionalContext`
 * envelope (claude-code/codex/kimi/cursor/hermes/gemini-cli) and cline's
 * native `{contextModification}` shape (see `runtime/respond.ts`'s `"cline"`
 * branch). A cline-shaped part used to parse to `""` here and get silently
 * dropped by the old `.filter(Boolean)` — exactly how cline's PRD slice never
 * reached the agent (0-byte `SubagentStart` injection) despite
 * `prdSubagentContext` building it correctly. When any merged part is
 * cline-native, the output is re-shaped as `{contextModification}` so
 * cline's own hook consumer (which never reads `hookSpecificOutput`) can
 * read it; every other target only ever produces Claude-family parts, so
 * that branch never triggers for them and their output stays
 * byte-identical.
 */
export function joinContextResponses(...parts: string[]): string {
  const extracted = parts.map(contextTextOf).filter((e): e is ExtractedContext => e !== null);
  if (extracted.length === 0) return "";
  const joined = extracted.map((e) => e.text).join("\n\n");
  if (extracted.some((e) => e.native)) return JSON.stringify({ contextModification: joined });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: joined },
  });
}

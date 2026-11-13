import type { Activity } from "./record";
import type { AgentQuality } from "../tracking/session-state";
import { classifyExplore } from "../freshness/explore-tools";
import { docFramework } from "../freshness/query-framework";
import { shellReadRefPaths } from "../policy/shell-read-refs";
import { isAgentTool } from "./is-agent-tool";
import { isCodexNativeWebTool } from "./codex-web-tool";

/** A live tool-use, already normalized to `tool` + `input` by the adapter. */
export interface ToolEvent {
  /** The harness's `tool_name` (Cline: `preToolUse.toolName`), as a plain string. */
  tool: string;
  input?: Record<string, unknown>;
  sessionId: string;
  framework: string;
  now: number;
  /** Length of the tool response (POST events) — drives agent `quality`. */
  responseLength?: number;
}

/** Quality thresholds (chars): lead agent calls vs direct explore/research (parity Python `> 50`). */
const AGENT_QUALITY_MIN = 500;
const EXPLORE_QUALITY_MIN = 50;

/** Read tools across harnesses (Claude `Read`, Gemini/Cline `read_file`, …). */
const READ_TOOLS = new Set(["Read", "read_file", "read_many_files"]);

/** Grade a response length against a threshold; `undefined` when length is unknown. */
function qualityFor(len: number | undefined, min: number): AgentQuality | undefined {
  return len === undefined ? undefined : len > min ? "sufficient" : "insufficient";
}

/** Build an `agent` activity, attaching `quality` only when graded. */
function agentActivity(name: string, ts: number, quality: AgentQuality | undefined): Activity {
  return quality ? { kind: "agent", name, ts, quality } : { kind: "agent", name, ts };
}

/**
 * The documentation source a tool satisfies for the doc-consultation gate, or
 * undefined. Context7/Exa are the primary sources; fuse-browser is the fallback
 * when Exa is down (`browser_fetch`/`browser_crawl`/`browser_serp_batch`); the
 * built-in WebSearch/WebFetch also count.
 * @param tool - The harness tool name.
 */
function docSourceOf(tool: string): string | undefined {
  if (/context7/i.test(tool)) return "context7";
  if (/exa/i.test(tool)) return "exa";
  if (/browser_(fetch|crawl|serp)/i.test(tool)) return "fuse-browser";
  if (tool === "WebSearch" || isCodexNativeWebTool(tool)) return "websearch";
  if (tool === "WebFetch") return "webfetch";
  if (/^mcp__shadcn__/i.test(tool)) return "shadcn-mcp";
  if (/^mcp__gemini-design__/i.test(tool)) return "gemini-mcp";
  return undefined;
}

/**
 * Map a live tool-use to the activity to record, or null when nothing is
 * tracked. Works across harnesses — tool names are globally distinct:
 * - MCP doc calls (`context7` / `exa`, any separator) → `doc`
 * - `Task`/`Agent`/`AgentSwarm` + `subagent_type` (Claude/Cursor/Kimi) → `agent` (bare agent name)
 * - direct exploration/research (Glob/Grep, explore Bash, web, MCP cache reads)
 *   → `agent` credited to the matching REQUIRED_AGENTS phase
 * - a read tool opening a `.md` reference → `ref`
 */
export function activityFor(event: ToolEvent): Activity[] {
  const out: Activity[] = [];
  // Doc consultation is recorded ALONGSIDE the research-phase credit (Python runs
  // track-doc-consultation + track-subagent-research as two independent hooks):
  // context7/exa/WebSearch/WebFetch AND fuse-browser (browser_fetch/crawl/serp_batch,
  // in RESEARCH_TOOLS since explore-tools.ts:38) all credit BOTH doc and research-expert.
  const docSource = docSourceOf(event.tool);
  if (docSource) out.push({ kind: "doc", framework: docFramework(event.input, event.framework, event.tool), sessionId: event.sessionId, source: docSource, ts: event.now });

  // AgentSwarm is Kimi Code's batch launcher — same `subagent_type` identity field.
  if (isAgentTool(event.tool)) {
    const name = String(event.input?.subagent_type ?? event.input?.name ?? "").split(":").pop() ?? "";
    if (name) out.push(agentActivity(name, event.now, qualityFor(event.responseLength, AGENT_QUALITY_MIN)));
    return out;
  }
  const hit = classifyExplore(event.tool, event.input);
  if (hit) {
    const quality = hit.cacheHit ? "sufficient" : qualityFor(event.responseLength, EXPLORE_QUALITY_MIN);
    out.push(agentActivity(hit.phase, event.now, quality));
  } else if (READ_TOOLS.has(event.tool)) {
    const path = String(event.input?.file_path ?? event.input?.path ?? "");
    // `event.now` is the event timestamp `recordRefRead` stamps into
    // `refsReadAt` (SOLID read TTL, parity track-solid-reads.py); `record.ts`
    // forwards it as `recordRefRead(track, path, ts)`.
    if (path.endsWith(".md")) out.push({ kind: "ref", path, ts: event.now });
  }
  // Codex teammates often read a skill/SOLID `.md` reference via a shell
  // command (`cat`, `head`, …) instead of a native Read — independent of the
  // classification above (a Bash call can ALSO be classified as `explore`
  // evidence by classifyExplore), so every detected path is credited as its
  // own `ref` activity (see shell-read-refs.ts for the read-only whitelist).
  if (event.tool === "Bash") {
    for (const path of shellReadRefPaths(event.input?.command)) out.push({ kind: "ref", path, ts: event.now });
  }
  return out;
}

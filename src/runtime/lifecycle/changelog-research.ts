/**
 * Changelog research tracker (PostToolUse exa/WebFetch/WebSearch). Ports
 * `track-watch-research.py`: logs research queries to
 * `~/.claude/logs/00-changelog/<utc-date>-research.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeHome } from "../home-state";
import { codexWebQueryText, isCodexNativeWebTool } from "../codex-web-tool";
import { isoUtc, todayUtc } from "./security/skill-state";

/** A recorded changelog research query. */
interface ChangelogQuery {
  timestamp: string;
  tool: string;
  query: string;
}

/**
 * Append an exa/WebFetch/WebSearch query to today's changelog research log.
 * No-op for other tools. No stdout (errors swallowed).
 * @param tool - The tool name.
 * @param input - The tool input (query/url/prompt).
 * @param now - Clock.
 * @param home - Home dir.
 */
export function trackWatchResearch(tool: string, input: Record<string, unknown>, now: number = Date.now(), home: string = homedir()): void {
  const codexWeb = isCodexNativeWebTool(tool);
  if (!tool.includes("exa") && !tool.includes("WebFetch") && !tool.includes("WebSearch") && !codexWeb) return;
  const query = codexWeb ? codexWebQueryText(input) : String(input.query ?? input.url ?? input.prompt ?? "");
  const dir = join(claudeHome(home), "logs", "00-changelog");
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${todayUtc(now)}-research.json`);
    let state: { queries: ChangelogQuery[] } = { queries: [] };
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf-8")) as { queries: ChangelogQuery[] };
      } catch { state = { queries: [] }; }
    }
    state.queries.push({ timestamp: isoUtc(now), tool, query });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  } catch { /* best effort */ }
}

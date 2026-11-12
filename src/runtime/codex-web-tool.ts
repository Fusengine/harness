/**
 * @module codex-web-tool
 * Identifies Codex CLI's native web tool (`web.run`) so the doc-consultation
 * gate credits it exactly like `WebSearch`/`WebFetch`.
 *
 * Codex ships the tool as an extension (`codex-rs/ext/web-search`):
 * `ToolName::namespaced("web", "run")`. Called from Code Mode it appears as
 * `tools.web__run({ search_query: [{ q }] })` or `tools.web__run({ open: [{ ref_id }] })`
 * and the extension adapter uses the generic `CoreToolRuntime` hook default
 * (`core/src/tools/registry.rs` `function_hook_tool_name` -> `flat_tool_name`,
 * `core/src/tools/mod.rs`), which concatenates namespace and name: `webrun`.
 * That hook name is derived from the Codex source (tag rust-v0.167.1) and NOT
 * yet observed live (a mock-provider probe cannot register the extension), so
 * the closed set also holds the two other spellings Codex itself uses for the
 * same tool: the Code Mode identifier `web__run` and the dotted `web.run`.
 * Exact matches only — never a pattern.
 * @packageDocumentation
 */

/** Every exact `tool_name` spelling of Codex's native `web.run` tool. */
const CODEX_WEB_TOOL_NAMES: ReadonlySet<string> = new Set(["webrun", "web__run", "web.run"]);

/**
 * The query text a `web.run` call carries, for framework classification and research logs:
 * every `search_query[].q` and `open[].ref_id` (codex-rs/ext/web-search/src/tool.rs; `ref_id`
 * is the only url-bearing field — there is no `url`). Non-string or malformed entries are skipped.
 * @param input - The tool_input of a `web.run` call.
 */
export function codexWebQueryText(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const [list, field] of [["search_query", "q"], ["open", "ref_id"]] as const) {
    const items = input[list];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const v = typeof item === "object" && item !== null ? (item as Record<string, unknown>)[field] : undefined;
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join(" ");
}

/**
 * True when `tool` is Codex's native web tool (search or open).
 * @param tool - Harness tool name from the normalized hook event.
 */
export function isCodexNativeWebTool(tool: string): boolean {
  return CODEX_WEB_TOOL_NAMES.has(tool);
}

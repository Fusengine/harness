/**
 * Framework classification for doc consultations, keyed on the QUERY text
 * (parity ai-pilot/scripts/track_doc_helpers.py::detect_framework): an MCP
 * doc call (context7/exa/web) has no filePath, so the file-based
 * `detectFramework()` always yields "generic" — the query keywords are the
 * only framework signal a doc consultation carries.
 */
import { codexWebQueryText, isCodexNativeWebTool } from "../runtime/codex-web-tool";

/**
 * Ordered patterns, EXACT parity with the Python list (same order, same
 * case-sensitive alternations, substring search — only `go` is word-bounded).
 * Quirks are inherited deliberately: "javascript" hits `java` (but only after
 * nextjs/react/laravel/swift/tailwind all missed) and all-caps "NEXT" misses.
 * The output domain matches `detectFramework()` exactly, so every credit
 * lands on a key the apex authorization gate actually reads.
 */
const QUERY_FRAMEWORKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(next|nextjs|Next)/, "nextjs"],
  [/(react|React)/, "react"],
  [/(laravel|Laravel|php|PHP)/, "laravel"],
  [/(swift|Swift|swiftui|SwiftUI)/, "swift"],
  [/(tailwind|Tailwind)/, "tailwind"],
  [/(java|Java|spring|Spring)/, "java"],
  [/\b(go|Go|golang)\b/, "go"],
  [/(ruby|Ruby|rails|Rails)/, "ruby"],
  [/(rust|Rust|cargo|Cargo)/, "rust"],
];

/**
 * The framework a doc query targets, or null when no keyword matches (the
 * Python returns "generic"; null here lets the caller fall back to the
 * event's file-detected framework instead of hardcoding generic).
 * @param query - The query/url/prompt text of the doc tool call.
 */
export function frameworkFromQuery(query: string): string | null {
  for (const [re, fw] of QUERY_FRAMEWORKS) if (re.test(query)) return fw;
  return null;
}

/**
 * tool_input fields carrying query text across doc tools: context7
 * (`libraryId`/`libraryName`, parity extract_tool_info), exa/WebSearch
 * (`query`), fuse-browser serp (`queries[]`), WebFetch (`url` + `prompt`).
 */
const QUERY_FIELDS = ["query", "queries", "libraryId", "libraryName", "prompt", "url"] as const;

/**
 * Fold every query-ish tool_input field into one searchable string. Distinct
 * from mcp-key.ts `queryOf`, which picks a SINGLE field to key the response
 * cache — classification wants ALL the text (e.g. WebFetch url + prompt).
 * @param input - The normalized tool_input (absent on some harnesses).
 */
export function docQueryOf(input: Record<string, unknown> | undefined, tool?: string): string {
  if (!input) return "";
  // Codex `web.run` carries its text in `search_query[].q` / `open[].ref_id`; every other tool keeps the fields below.
  if (tool !== undefined && isCodexNativeWebTool(tool)) return codexWebQueryText(input);
  const parts: string[] = [];
  for (const key of QUERY_FIELDS) {
    const v = input[key];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const s of v) if (typeof s === "string") parts.push(s);
  }
  return parts.join(" ");
}

/**
 * The framework to credit for a doc consultation: the query's framework when
 * a keyword matches (query wins over file-based detection), else `fallback`
 * (the event's framework — "generic" for pathless MCP calls).
 * @param input - The doc tool's tool_input.
 * @param fallback - The event's file-detected framework.
 * @param tool - The tool name; only Codex's `web.run` changes how the input is read.
 */
export function docFramework(input: Record<string, unknown> | undefined, fallback: string, tool?: string): string {
  return frameworkFromQuery(docQueryOf(input, tool)) ?? fallback;
}

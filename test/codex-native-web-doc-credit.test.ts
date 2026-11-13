import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { trackFile, defaultStateDir } from "../src/runtime/paths";
import { loadTrack } from "../src/tracking/store";
import { isDocConsulted } from "../src/freshness/doc-helpers";
import { isCodexNativeWebTool } from "../src/runtime/codex-web-tool";
import { trackWatchResearch } from "../src/runtime/lifecycle/changelog-research";

/**
 * Codex's native web tool (`web.run`, extension `codex-rs/ext/web-search`) is called from Code Mode as
 * `tools.web__run({ search_query: [{ q }] })` / `tools.web__run({ open: [{ ref_id }] })`. Its hook
 * `tool_name` is the namespace+name concatenation `webrun` (core/src/tools/mod.rs `flat_tool_name`).
 * The doc-consultation gate must credit it exactly like `WebSearch`/`WebFetch`.
 */
const SEARCH_INPUT = { search_query: [{ q: "zustand typescript guide" }] };
const OPEN_INPUT = { open: [{ ref_id: "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html" }], response_length: "short" };

/** Send one PostToolUse for `tool` to `host`, then report whether the session counts as doc-consulted. */
async function consulted(host: string, tool: string, input: Record<string, unknown>): Promise<boolean> {
  const cwd = mkdtempSync(join(tmpdir(), "fh-cxweb-"));
  const sid = "s-cxweb";
  await handleHook(host, { session_id: sid, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: "ok", tool_use_id: "call-1", cwd }, { now: 1000, cwd });
  const track = await loadTrack(trackFile(sid, defaultStateDir(cwd)));
  return isDocConsulted(track.authorizations, sid);
}

test("RED->GREEN: Codex native web search is credited as documentation consulted", async () => {
  expect(await consulted("codex", "webrun", SEARCH_INPUT)).toBe(true);
});

test("Codex native web open (ref_id url) is credited", async () => {
  expect(await consulted("codex", "webrun", OPEN_INPUT)).toBe(true);
});

test("other exact spellings of the same tool are credited (web__run, web.run)", async () => {
  expect(await consulted("codex", "web__run", SEARCH_INPUT)).toBe(true);
  expect(await consulted("codex", "web.run", OPEN_INPUT)).toBe(true);
});

test("an unrelated native web call counts exactly as much as an arbitrary WebFetch (no query keyword needed)", async () => {
  expect(await consulted("codex", "WebFetch", { url: "https://example.com/x", prompt: "x" })).toBe(true);
  expect(await consulted("codex", "webrun", { search_query: [{ q: "weather in Paris" }] })).toBe(true);
});

test("controls: no research -> still not consulted", async () => {
  expect(await consulted("codex", "update_plan", { plan: [] })).toBe(false);
  expect(await consulted("codex", "exec_command", { cmd: "ls" })).toBe(false);
});

test("controls: near-miss names are NOT credited (exact set only, no catch-all)", async () => {
  for (const tool of ["web", "run", "web_run", "websearch", "webrunner", "xwebrun", "mcp__web__run", "WebRun", "web.search"]) {
    expect(isCodexNativeWebTool(tool)).toBe(false);
    expect(await consulted("codex", tool, SEARCH_INPUT)).toBe(false);
  }
});

test("controls: existing credits unchanged (MCP, WebSearch, WebFetch, fuse-browser, Kimi, Cursor)", async () => {
  expect(await consulted("codex", "mcp__fuse_browser__browser_fetch", { url: "https://x" })).toBe(true);
  expect(await consulted("claude-code", "WebSearch", { query: "x" })).toBe(true);
  expect(await consulted("claude-code", "WebFetch", { url: "https://x", prompt: "p" })).toBe(true);
  expect(await consulted("claude-code", "mcp__exa__web_search_exa", { query: "x" })).toBe(false); // Exa alone never satisfied the gate (needs Context7 too)
  expect(await consulted("claude-code", "mcp__context7__query-docs", { libraryId: "x" })).toBe(false);
  expect(await consulted("kimi", "WebSearch", { query: "x" })).toBe(true);
  expect(await consulted("claude-code", "Read", { file_path: "/p/a.ts" })).toBe(false);
});

// ---- Check-1 (per-framework stamp) + changelog log parity with WebSearch ----

/** Stamped framework keys after one PostToolUse consultation. */
async function stampedKeys(host: string, tool: string, input: Record<string, unknown>): Promise<string[]> {
  const cwd = mkdtempSync(join(tmpdir(), "fh-cxweb-fw-"));
  const sid = "s-cxweb-fw";
  await handleHook(host, { session_id: sid, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: "ok", tool_use_id: "c1", cwd }, { now: 1000, cwd });
  const track = await loadTrack(trackFile(sid, defaultStateDir(cwd)));
  return Object.keys(track.authorizations ?? {}).sort();
}

/** Final Write verdict (normalized) on `file` after one consultation, in a plain tsconfig project. */
async function writeVerdict(tool: string, input: Record<string, unknown>, file: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "fh-cxweb-wv-"));
  const sid = "s-cxweb-wv";
  writeFileSync(join(cwd, "tsconfig.json"), "{}");
  await handleHook("codex", { session_id: sid, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: "ok", tool_use_id: "c1", cwd }, { now: 1000, cwd });
  const path = join(cwd, "src", file);
  const out = await handleHook("codex", { session_id: sid, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+export const a = 1;\n*** End Patch` }, tool_use_id: "c2", cwd }, { now: 2000, cwd });
  return JSON.stringify(out).split(cwd).join("<D>");
}

const FRAMEWORK_QUERIES = ["react useEffect", "laravel eloquent", "next app router", "weather in Paris", "swift concurrency", "cargo rust"];

test("Check-1: web.run stamps the SAME framework keys as the WebSearch twin (search + open)", async () => {
  for (const q of FRAMEWORK_QUERIES) {
    const twin = await stampedKeys("codex", "WebSearch", { query: q });
    expect(await stampedKeys("codex", "webrun", { search_query: [{ q }] })).toEqual(twin);
    expect(await stampedKeys("codex", "web__run", { search_query: [{ q }] })).toEqual(twin);
    const url = `https://docs.example/${q.split(" ")[0]}`;
    expect(await stampedKeys("codex", "web.run", { open: [{ ref_id: url }] })).toEqual(await stampedKeys("codex", "WebFetch", { url }));
  }
});

test("Check-1: 'react useEffect' stamps react (not the cwd framework); 'laravel' stamps laravel", async () => {
  expect(await stampedKeys("codex", "webrun", { search_query: [{ q: "react useEffect" }] })).toContain("react");
  expect(await stampedKeys("codex", "webrun", { search_query: [{ q: "laravel eloquent" }] })).toContain("laravel");
});

test("Check-1: every web.run Write verdict equals its WebSearch twin (.tsx / .ts / .php)", async () => {
  for (const q of FRAMEWORK_QUERIES) {
    for (const file of ["App.tsx", "a.ts", "a.php"]) {
      expect(await writeVerdict("webrun", { search_query: [{ q }] }, file)).toBe(await writeVerdict("WebSearch", { query: q }, file));
    }
  }
});

test("malformed web.run input never throws and stamps like an empty WebSearch query", async () => {
  expect(await stampedKeys("codex", "webrun", { search_query: "react", open: [null, 3, { ref_id: 7 }] })).toEqual(await stampedKeys("codex", "WebSearch", {}));
});

test("changelog research log: web.run is logged like WebSearch; near-miss names are not", () => {
  const home = mkdtempSync(join(tmpdir(), "fh-cxweb-cl-"));
  const now = 1_800_000_000_000;
  trackWatchResearch("webrun", { search_query: [{ q: "claude code changelog" }] }, now, home);
  trackWatchResearch("WebSearch", { query: "claude code changelog" }, now, home);
  trackWatchResearch("web", { search_query: [{ q: "x" }] }, now, home);
  const logs = [...new Bun.Glob("**/*-research.json").scanSync({ cwd: home, absolute: true, dot: true })];
  expect(logs.length).toBe(1);
  const queries = (JSON.parse(readFileSync(logs[0] as string, "utf-8")) as { queries: Array<{ query: string }> }).queries;
  expect(queries.map((q) => q.query)).toEqual(["claude code changelog", "claude code changelog"]);
});

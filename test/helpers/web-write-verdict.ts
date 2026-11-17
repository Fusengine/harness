import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../../src/runtime/handle";

/** Creates a fresh project directory for one verdict probe. */
export type CwdFactory = () => string;

let seq = 0;

/**
 * Project directory whose name is deterministic-in-shape: `<prefix><pid>-<n>` — digits only after the prefix.
 * The design gate matches UI-path fragments (`ui`, `nav`, `page`, ...) against the WHOLE absolute path, so a
 * random `mkdtemp` suffix (62-letter alphabet) matches one in ~0.19 % of calls and makes two otherwise
 * identical probes disagree. Digits can never form such a fragment.
 * @param prefix - Letter-free-of-fragments prefix, e.g. `fh-cxweb-wv-`.
 */
export function neutralTempDir(prefix: string): string {
  for (;;) {
    const dir = join(tmpdir(), `${prefix}${process.pid}-${seq++}`);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** The pre-fix factory: random `mkdtemp` suffix (kept only to reproduce the CI flake). */
export const randomTempDir: CwdFactory = () => mkdtempSync(join(tmpdir(), "fh-cxweb-wv-"));

/** Default factory used by Check-1: name can never match the design gate's path heuristics. */
export const neutralCwd: CwdFactory = () => neutralTempDir("fh-cxweb-wv-");

/**
 * Final Codex Write verdict (normalized: cwd replaced by `<D>`) on `file` after one doc consultation,
 * in a plain tsconfig project created by `makeCwd`.
 * @param tool - Consulting tool name (`webrun`, `WebSearch`, ...).
 * @param input - Its tool input.
 * @param file - File name written under `<cwd>/src/`.
 * @param makeCwd - Project directory factory (default: {@link neutralCwd}).
 */
export async function writeVerdict(tool: string, input: Record<string, unknown>, file: string, makeCwd: CwdFactory = neutralCwd): Promise<string> {
  const cwd = makeCwd();
  const sid = "s-cxweb-wv";
  writeFileSync(join(cwd, "tsconfig.json"), "{}");
  await handleHook("codex", { session_id: sid, hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: "ok", tool_use_id: "c1", cwd }, { now: 1000, cwd });
  const path = join(cwd, "src", file);
  const out = await handleHook("codex", { session_id: sid, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+export const a = 1;\n*** End Patch` }, tool_use_id: "c2", cwd }, { now: 2000, cwd });
  return JSON.stringify(out).split(cwd).join("<D>");
}

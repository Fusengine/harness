import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilterInput } from "../src/runtime/inject-session/filter";

const dirs: string[] = [];
const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, proj: process.env.CLAUDE_PROJECT_DIR };

/** afterEach body: remove scratch dirs and restore the env the tests touch. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o755); } catch { /* gone */ }
    rmSync(d, { recursive: true, force: true });
  }
  if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
  if (saved.proj === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.proj;
}
/** Scratch dir (removed by {@link cleanup}). */
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "inject-hard-"));
  dirs.push(d);
  return d;
}
/** Distinct paragraphs totalling ~`n` chars. */
export function body(n: number, tag = "u"): string {
  const out: string[] = [];
  for (let i = 0; out.join("\n\n").length < n; i++) out.push(`${tag}${i} ${"z".repeat(400)}`);
  return out.join("\n\n");
}
/** Filter input for `event` of session s1; `loader` style overrides go in `o`. */
export function inp(stateDir: string, event: string, o: Partial<FilterInput> & { extra?: Record<string, unknown> } = {}): FilterInput {
  return { payload: { hook_event_name: event, session_id: "s1", ...o.extra }, stateDir, home: tmp(), now: 1, scope: "rules", ...o };
}
/** additionalContext of a stdout ("" when none). */
export const ctxOf = (s: string): string => (s ? ((JSON.parse(s).hookSpecificOutput?.additionalContext as string | undefined) ?? "") : "");

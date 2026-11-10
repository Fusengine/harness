import { test, expect, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { projectStateDir } from "../src/runtime/project-state-dir";
import { recordOneShot, oneShotSummary } from "../src/tracking/one-shot";
import { postCompactContext } from "../src/runtime/lifecycle/post-compact";
import { join } from "node:path";
import { resolveProjectDir } from "../src/util/project-dir";
import { defaultStateDir, trackFile } from "../src/runtime/paths";
import { harvestSubagentTrack } from "../src/freshness/evidence-harvest-io";
import { agentsFreshInTrack } from "../src/freshness/agent-evidence-record";
import { stopCore } from "../src/runtime/lifecycle/stop-core";
import { saveSessionState } from "../src/runtime/home-state";
import { saveTrack, loadTrack } from "../src/tracking/store";
import { recordReceipt } from "../src/tracking/receipts";
import { emptyTrack } from "../src/tracking/session-state";

const NOW = 1_000_000_000_000;
const saved = process.env.CLAUDE_PROJECT_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
});

/** Project `/a` with a sub-directory `/a/sub`. Run with `HOME=$(mktemp -d)` on the command line (os.homedir() is read at process start). */
function fixture(): { proj: string; sub: string } {
  const proj = mkdtempSync(join(tmpdir(), "fh-a1-proj-"));
  const sub = join(proj, "sub");
  mkdirSync(sub);
  process.env.CLAUDE_PROJECT_DIR = proj;
  return { proj, sub };
}

test("a1 resolveProjectDir: CLAUDE_PROJECT_DIR wins when non-empty, else cwd", () => {
  expect(resolveProjectDir("/c", { CLAUDE_PROJECT_DIR: "/a" })).toBe("/a");
  expect(resolveProjectDir("/c", { CLAUDE_PROJECT_DIR: "" })).toBe("/c");
  expect(resolveProjectDir("/c", {})).toBe("/c");
});

test("a1 integration: CLAUDE_PROJECT_DIR=/a, cwd=/a/sub — SubagentStop harvest lands where PreToolUse reads (project hash), not the cwd hash", async () => {
  const { proj, sub } = fixture();
  const tr = join(proj, "agent.jsonl");
  writeFileSync(tr, [
    { name: "mcp__exa__web_search_exa", input: { query: "q" }, ts: NOW - 1000 },
    { name: "Glob", input: { pattern: "**/*.ts" }, ts: NOW - 900 },
  ].map((b) => JSON.stringify({ timestamp: new Date(b.ts).toISOString(), message: { content: [{ type: "tool_use", name: b.name, input: b.input }] } })).join("\n") + "\n");
  harvestSubagentTrack({ session_id: "ia1", agent_transcript_path: tr }, sub, NOW);
  // handle.ts (PreToolUse) keys the track on defaultStateDir(resolveProjectDir(cwd)) = project hash.
  const atProject = await loadTrack(trackFile("ia1", defaultStateDir(resolveProjectDir(sub))));
  expect(agentsFreshInTrack(atProject, ["explore-codebase", "research-expert"], 120_000, NOW)).toBe(true);
  expect(defaultStateDir(resolveProjectDir(sub))).toBe(defaultStateDir(proj));
  const atCwd = await loadTrack(trackFile("ia1", defaultStateDir(sub)));
  expect(atCwd.agents.length).toBe(0);
});

test("a1 integration: CLAUDE_PROJECT_DIR=/a, cwd=/a/sub — Stop sees the receipt stored at the project hash", async () => {
  const { proj, sub } = fixture();
  const f = join(proj, "ok.ts");
  writeFileSync(f, "export const x = 1;\n");
  saveSessionState("ia2", { changes: { modifiedFiles: [f] } }, homedir());
  saveSessionState("ia2-control", { changes: { modifiedFiles: [f] } }, homedir());
  // Control: no receipt anywhere -> Stop refuses (proves this setup can refuse at all).
  expect(stopCore({ session_id: "ia2-control", cwd: sub }, sub, NOW)).toContain("VERIFICATION RECEIPT REQUIRED");
  await saveTrack(trackFile("ia2", defaultStateDir(proj)), recordReceipt(emptyTrack(), { kind: "test", tool: "bun test", exitCode: 0, pass: 3, fail: 0, ts: NOW - 1000 }));
  expect(stopCore({ session_id: "ia2", cwd: sub }, sub, NOW)).toBe("");
});

test("a1 projectStateDir: equals defaultStateDir(CLAUDE_PROJECT_DIR) from a sub-directory cwd", () => {
  const { proj, sub } = fixture();
  expect(projectStateDir(sub)).toBe(defaultStateDir(proj));
  expect(projectStateDir(sub)).not.toBe(defaultStateDir(sub));
});

test("a1 integration: one-shot written under the project hash is read back by oneShotSummary(cwd=/a/sub)", () => {
  const { proj, sub } = fixture();
  // gate.ts writes into dirname(trackFile) = the resolved project state dir.
  recordOneShot(null, { filePath: join(proj, "z.ts"), content: "x" }, { now: Date.now(), dir: defaultStateDir(proj) });
  expect(oneShotSummary(sub)).not.toBe("");
});

test("a1 integration: dedupe sidecar (postCompact) lands in the project state dir, not the cwd one", () => {
  const { proj, sub } = fixture();
  postCompactContext({ session_id: "pc1" }, sub, import.meta.url, NOW);
  expect(existsSync(join(defaultStateDir(proj), "inject-dedup.json"))).toBe(true);
  expect(existsSync(join(defaultStateDir(sub), "inject-dedup.json"))).toBe(false);
});

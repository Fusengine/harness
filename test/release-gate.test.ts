import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordReviewReport, readReviewReports } from "../src/runtime/release-gate/store";
import { releaseGatePrompt } from "../src/runtime/release-gate/gate";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

let home: string;
let cwd: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rg-home-")); cwd = mkdtempSync(join(tmpdir(), "rg-cwd-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });

const stop = (agent: string) => ({ hook_event_name: "SubagentStop", session_id: "s1", agent_type: agent, agent_id: "a-1" });
const gate = (command: string, lastEdit: number, now = 5000) => releaseGatePrompt(command, { projectDir: cwd, lastEdit, home, now });

test("recordReviewReport stamps sniper and challenger, ignores other agents", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 100, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 200, home);
  recordReviewReport(stop("fuse-ai-pilot:explore-codebase"), cwd, 900, home);
  recordReviewReport(stop("fuse-ai-pilot:sniper-faster"), cwd, 900, home);
  recordReviewReport({ session_id: "s1" }, cwd, 900, home);
  expect(readReviewReports(cwd, home)).toEqual({ sniper: 100, challenger: 200 });
});

test("recordReviewReport is monotone: an older now never overwrites a newer stamp", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 500, home);
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 300, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 700, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 100, home);
  expect(readReviewReports(cwd, home)).toEqual({ sniper: 500, challenger: 700 });
});

test("WIP commit is allowed without any report", () => {
  expect(gate("git commit -m 'wip'", 1000)).toBeNull();
  expect(gate("git add -A && git commit -m wip", 1000)).toBeNull();
});

test("merge and tag are asked without reports", () => {
  expect(gate("gh pr merge 5 --merge", 1)?.kind).toBe("ask");
  expect(gate("git tag v1.0.0", 1)?.kind).toBe("ask");
  expect(gate("npm test && gh pr merge 5", 1)?.kind).toBe("ask");
});

test("tag listing is allowed without reports", () => {
  expect(gate("git tag -l", 0)).toBeNull();
});

test("one report only is not enough", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 2000, home);
  expect(gate("git tag v1", 1000)?.kind).toBe("ask");
});

test("allowed after sniper then challenger newer than the last code edit", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 2000, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 3000, home);
  expect(gate("gh pr merge 5", 1000)).toBeNull();
  expect(gate("git tag v1", 1000)).toBeNull();
});

test("blocked again after a later code edit", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 2000, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 3000, home);
  expect(gate("git tag v1", 4000)?.kind).toBe("ask");
  expect(gate("gh pr merge 5", 3000)?.kind).toBe("ask");
});

test("docs-only release: non-code edits never move lastEdit, reports stay valid", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 2000, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 3000, home);
  expect(gate("git tag v1.0.1", 1000)).toBeNull();
});

test("reports are per project", () => {
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 2000, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 3000, home);
  expect(releaseGatePrompt("git tag v1", { projectDir: join(cwd, "other"), lastEdit: 1, home, now: 5000 })?.kind).toBe("ask");
});

const pre = (s: string, command: string) => ({
  hook_event_name: "PreToolUse", session_id: s, tool_name: "Bash", tool_input: { command }, cwd,
});

test("end-to-end claude-code: tag asks, commit passes, allowed after reports", async () => {
  const opts: HandleOptions = { now: 10_000, cwd, home };
  const s = "rg-e2e-1";
  trackSessionChanges(s, join(cwd, "src", "a.ts"), home, 9_000);
  const asked = await handleHook("claude-code", pre(s, "git tag v1.0.0"), opts);
  expect(asked.stdout).toContain("\"ask\"");
  expect(asked.stdout).toContain("Release gate");
  recordReviewReport(stop("fuse-ai-pilot:sniper"), cwd, 11_000, home);
  recordReviewReport(stop("fuse-ai-pilot:challenger"), cwd, 12_000, home);
  const ok = await handleHook("claude-code", pre(s, "git tag v1.0.0"), { ...opts, now: 13_000 });
  expect(ok.stdout).not.toContain("Release gate");
});

test("end-to-end cursor: ask is downgraded to deny and carries a CONFIRM code (override)", async () => {
  const opts: HandleOptions = { now: 10_000, cwd, home };
  const s = "rg-e2e-cursor";
  trackSessionChanges(s, join(cwd, "src", "a.ts"), home, 9_000);
  const denied = await handleHook("cursor", { hook_event_name: "preToolUse", conversation_id: s, session_id: s, generation_id: "g1", tool_name: "Shell", tool_use_id: "t1", tool_input: { command: "gh pr merge 5" }, cwd, workspace_roots: [cwd] }, opts);
  expect(denied.stdout).toContain("CONFIRM ");
});

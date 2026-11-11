import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setupFixture, teardownFixture, type PrecommitFixture } from "./helpers/precommit-fixture";

const BIN = join(import.meta.dir, "../src/cli/bin.ts");
let fx: PrecommitFixture;
beforeAll(() => { fx = setupFixture(); });
afterAll(() => teardownFixture(fx));

/** Real CLI replay: the hook PROCESS runs in `processCwd`, the payload carries `payloadCwd` (the session's real dir). */
function replay(command: string, processCwd: string, payloadCwd: string | undefined): string {
  const payload = { hook_event_name: "PreToolUse", session_id: "pcwt-s", tool_name: "Bash", tool_input: { command }, ...(payloadCwd ? { cwd: payloadCwd } : {}) };
  const home = mkdtempSync(join(fx.base, "home-"));
  const r = spawnSync("bun", [BIN, "hook", "claude-code", "core"], {
    cwd: processCwd, input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, PATH: `${fx.fakeBin}:${process.env.PATH ?? ""}`, CLAUDE_PROJECT_DIR: processCwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return r.stdout;
}
const blocked = (out: string): boolean => out.includes("COMMIT BLOCKED");

test("CLI replay: hook process in the main checkout, payload cwd = worktree -> not blocked", () => {
  expect(blocked(replay("git commit -m y", fx.main, fx.wt))).toBe(false);
});

test("CLI replay: payload cwd = main checkout -> blocked (control)", () => {
  expect(blocked(replay("git commit -m y", fx.wt, fx.main))).toBe(true);
});

test("CLI replay: no payload cwd falls back to the hook process cwd", () => {
  expect(blocked(replay("git commit -m y", fx.wt, undefined))).toBe(false);
  expect(blocked(replay("git commit -m y", fx.main, undefined))).toBe(true);
});

test("CLI replay: read-only git without the word commit never triggers; with it, it is the documented false trigger (main's behaviour)", () => {
  for (const [c, fires] of [["git show --stat HEAD", false], ['echo "git commit"', false], ["git status", false], ["git log -1 --format='%h commit-probe'", true], ["git log --grep=commit", true]] as const) {
    expect([c, blocked(replay(c, fx.main, fx.main))]).toEqual([c, fires]);
  }
  // In a worktree session the false trigger at least lints the worktree (passes), never the main checkout.
  expect(blocked(replay("git log --grep=commit", fx.main, fx.wt))).toBe(false);
});

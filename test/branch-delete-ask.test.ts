/**
 * Branch / worktree deletion asks: `git branch -d|--delete`, `git worktree remove`
 * and `gh pr merge --delete-branch|-d` confirm (ask) instead of running silently,
 * also behind the wrappers the git gates peel. Every existing deny stays a deny,
 * nothing else changes verdict, and each non-Claude host downgrades the ask to a
 * deny that carries a CONFIRM code (unchanged mechanism).
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { kind } from "./helpers/wrapper-law";

const ASKS = [
  "git branch -d x", "git branch --delete x", "git branch -f -d x", "git branch -fd x", "git branch -df x", "git branch -d -f x", "git branch --delete --force x", "git branch -dr origin/x",
  "gh pr merge 5 --merge --delete-branch", "gh pr merge 5 -d", "gh pr merge 5 -md", "gh pr merge 5 --delete-branch=true", "gh pr merge 5 -R o/r --delete-branch",
  "git worktree remove ../w", "git worktree remove --force ../w",
  "git push origin --delete x", "git push -d origin x", "git push origin :x",
];
const WRAPPERS = ["{C}", "git -C r {C}", "cd r && {C}", "sh -c '{C}'", "( {C} )", "FOO=1 {C}", "eval '{C}'", "echo '{C}' | sh"];
const wrap = (w: string, c: string): string => (w.startsWith("git -C") ? c.replace(/^git /, "git -C r ") : w.replace("{C}", c));

describe("deletions ask (bare and behind every wrapper)", () => {
  test.each(ASKS)("%s -> ask", (c) => {
    expect(kind(c)).toBe("ask");
  });
  test.each(ASKS.filter((c) => !c.startsWith("git push")))("%s keeps asking behind every wrapper", (c) => {
    for (const w of WRAPPERS) expect([w, kind(wrap(w, c))]).toEqual([w, "ask"]);
  });
});

describe("unchanged verdicts", () => {
  test("existing denies stay denies", () => {
    for (const c of ["git branch -D x", "git branch -m a b", "git branch new-name", "git push --force origin x", "gh pr merge 5 --squash --delete-branch", "gh pr merge 5 -sd", "cd r && git branch -D x"]) {
      expect([c, kind(c)]).toEqual([c, "block"]);
    }
  });
  test("a deny elsewhere in the line is never turned into an ask", () => {
    for (const c of ["git reset --hard && git branch -d x", "git branch -d x; git push --force", "git worktree remove w && git clean -fd"]) {
      expect([c, kind(c)]).toEqual([c, "block"]);
    }
  });
  test.each([
    "git branch", "git branch -a", "git branch -r", "git branch -vv", "git branch --list 'dev*'", "git branch --show-current", "git branch --contains abc",
    "git worktree add ../w", "git worktree list", "git worktree prune",
    "gh pr merge 5 --merge", "gh pr merge 5 -m", "gh pr merge 5 -b 'x -d y' -m", "gh pr merge 5 -t -d -m", "gh pr merge 5 --delete-branch=false --merge",
    "gh pr view 5", "gh pr list", "git log --oneline", "git status", "echo hi",
  ])("%s -> allow", (c) => {
    expect(kind(c)).toBe("allow");
  });
});

describe("per host: ask on claude-code, downgraded deny with a CONFIRM code elsewhere", () => {
  const ENV = process.env.HOME;
  const out = async (id: string, event: Record<string, unknown>): Promise<string> => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "fh-bda-home-"));
    try { return (await handleHook(id, event, { now: 1000, cwd: mkdtempSync(join(tmpdir(), "fh-bda-cwd-")) })).stdout; } finally { process.env.HOME = ENV; }
  };
  const payload = (command: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: "s-bda", tool_name: "Bash", tool_input: { command }, ...extra });
  const SAMPLES = ["git branch --delete x", "gh pr merge 5 --merge --delete-branch", "git worktree remove --force ../w"];

  test("claude-code asks", async () => {
    for (const c of SAMPLES) expect(JSON.parse(await out("claude-code", payload(c))).hookSpecificOutput.permissionDecision).toBe("ask");
  });
  test("codex and kimi deny with a CONFIRM code", async () => {
    for (const id of ["codex", "kimi"]) for (const c of SAMPLES) expect([id, await out(id, payload(c))]).toEqual([id, expect.stringMatching(/CONFIRM [0-9a-f]{4}/i)]);
  });
  test("cursor denies with a CONFIRM code", async () => {
    for (const c of SAMPLES) {
      const o = await out("cursor", { hook_event_name: "beforeShellExecution", conversation_id: "s-bda", generation_id: "g", command: c, cwd: "/tmp" });
      expect(o).toMatch(/CONFIRM [0-9a-f]{4}/i);
    }
  });
  test("control: a plain listing is not prompted on any host", async () => {
    for (const id of ["claude-code", "codex", "kimi"]) expect(await out(id, payload("git branch -a"))).not.toMatch(/CONFIRM|"ask"|"deny"/);
  });
});

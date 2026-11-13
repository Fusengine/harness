import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInit } from "../src/init/templates";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

const temp = (name: string): string => mkdtempSync(join(tmpdir(), `fh-${name}-`));
const sid = (label: string): string => `${label}-${randomUUID()}`;
const pre = (s: string, command: unknown, toolUseId?: string, cwd?: string) => ({
  hook_event_name: "PreToolUse", session_id: s, tool_use_id: toolUseId,
  cwd, tool_name: "Bash", tool_input: { command },
});
const submit = (s: string, prompt: string) => ({ hook_event_name: "UserPromptSubmit", session_id: s, prompt });
function codeFrom(stdout: string): string {
  const code = stdout.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
  if (!code) throw new Error(`missing code: ${stdout}`);
  return code;
}

test("consumed confirmation text cannot re-arm without a new denial", async () => {
  const home = temp("confirm-home"), cwd = temp("confirm-cwd"), s = sid("replay"), command = "git commit -m replay";
  const opts: HandleOptions = { now: 1000, cwd, home };
  const denied = await handleHook("codex", pre(s, command, "tool-a", cwd), opts);
  const code = codeFrom(denied.stdout);
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
  await handleHook("codex", pre(s, command, "tool-a", cwd), { ...opts, now: 1200 });
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1250 });
  const replay = await handleHook("codex", pre(s, command, "tool-b", cwd), { ...opts, now: 1300 });
  expect(JSON.parse(replay.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("modified command denies with mismatch but the armed action stays valid", async () => {
  const home = temp("confirm-home"), cwd = temp("confirm-cwd"), s = sid("mismatch"), opts = { now: 1000, cwd, home };
  const denied = await handleHook("codex", pre(s, "git commit -m a", "tool-a", cwd), opts);
  await handleHook("codex", submit(s, `CONFIRM ${codeFrom(denied.stdout)}`), { ...opts, now: 1100 });
  expect((await handleHook("codex", pre(s, "git commit -m b", "tool-b", cwd), { ...opts, now: 1200 })).stdout).toContain("rejection: mismatch");
  // A token armed by the human is NOT erased by the denial of another command (multi-pending).
  const original = await handleHook("codex", pre(s, "git commit -m a", "tool-a", cwd), { ...opts, now: 1300 });
  expect(original.stdout).not.toContain('"permissionDecision":"deny"');
});

test("argv/string transport is canonical and a different cwd invalidates", async () => {
  const home = temp("confirm-home"), cwd = temp("confirm-cwd"), other = temp("confirm-cwd"), command = "git commit -m transport";
  const opts: HandleOptions = { now: 1000, cwd, home }, s1 = sid("transport");
  const denied = await handleHook("codex", pre(s1, ["bash", "-lc", command], "tool-a", cwd), opts);
  await handleHook("codex", submit(s1, `CONFIRM ${codeFrom(denied.stdout)}`), { ...opts, now: 1100 });
  expect((await handleHook("codex", pre(s1, command, "tool-a", cwd), { ...opts, now: 1200 })).stdout).not.toContain('"permissionDecision":"deny"');
  const s2 = sid("cwd"), denied2 = await handleHook("codex", pre(s2, command, "tool-b", cwd), opts);
  await handleHook("codex", submit(s2, `CONFIRM ${codeFrom(denied2.stdout)}`), { ...opts, now: 1100 });
  expect((await handleHook("codex", pre(s2, command, "tool-b", other), { ...opts, now: 1200 })).stdout).toContain("rejection: mismatch");
});

test("diagnostics expose stable fields and missing tool_use_id is typed", async () => {
  const home = temp("confirm-home"), cwd = temp("confirm-cwd"), s = sid("diagnostic"), command = "prog log > out.txt";
  const opts: HandleOptions = { now: 1000, cwd, home }, denied = await handleHook("codex", pre(s, command, "tool-a", cwd), { now: 1000, cwd, home });
  expect(denied.stdout).toContain("rule ID: bash-write:file-redirect");
  expect(denied.stdout).toContain(`canonical command: ${command}`);
  expect(denied.stdout).toMatch(/expected token: CONFIRM [0-9a-f]{4}/);
  expect(denied.stdout).toContain("rejection: no-token");
  await handleHook("codex", submit(s, `CONFIRM ${codeFrom(denied.stdout)}`), { ...opts, now: 1100 });
  expect((await handleHook("codex", pre(s, command, undefined, cwd), { ...opts, now: 1200 })).stdout).toContain("rejection: missing-tool-use-id");
  expect((await handleHook("codex", pre(s, command, "tool-a", cwd), { ...opts, now: 1300 })).stdout).not.toContain('"permissionDecision":"deny"');
});

test("UserPromptSubmit is wired and processed before scope early returns", async () => {
  const hooks = JSON.parse(codexInit("harness hook codex")[0]!.content) as { hooks: Record<string, unknown[]> };
  expect(hooks.hooks.UserPromptSubmit?.length).toBe(1);
  const home = temp("confirm-home"), cwd = temp("confirm-cwd"), s = sid("scope"), command = "git commit -m scope";
  const opts: HandleOptions = { now: 1000, cwd, home }, denied = await handleHook("codex", pre(s, command, "tool-a", cwd), { now: 1000, cwd, home });
  await handleHook("codex", submit(s, `CONFIRM ${codeFrom(denied.stdout)}`), { ...opts, now: 1100, scope: "rules" });
  expect((await handleHook("codex", pre(s, command, "tool-a", cwd), { ...opts, now: 1200 })).stdout).not.toContain('"permissionDecision":"deny"');
});

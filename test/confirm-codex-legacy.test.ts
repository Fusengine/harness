/**
 * Codex-side CONFIRM tests moved out of confirm.test.ts verbatim (file-size
 * split, hook ceiling 200) — EXCEPT the "command mismatch" test, updated to
 * the mandated multi-pending semantics: an armed token survives the denial of
 * ANOTHER command.
 */
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleHook, type HandleOptions } from "../src/runtime/handle";
import { codexInit } from "../src/init/templates";

const cwd = (): string => mkdtempSync(join(tmpdir(), "fh-confirm-cwd-"));
const home = (): string => mkdtempSync(join(tmpdir(), "fh-confirm-home-"));
const sid = (label: string): string => `${label}-${randomUUID()}`;

const codexPre = (s: string, command: string, toolUseId: string, workdir: string) => ({
  hook_event_name: "PreToolUse",
  session_id: s,
  tool_use_id: toolUseId,
  cwd: workdir,
  tool_name: "Bash",
  tool_input: { command },
});
const submit = (s: string, prompt: string) => ({ hook_event_name: "UserPromptSubmit", session_id: s, prompt });

/** Extract the 4-hex-char code from a "To allow, reply: CONFIRM xxxx" deny message. */
function codeFromDeny(stdout: string): string {
  const m = stdout.match(/CONFIRM ([0-9a-f]{4})/i);
  const code = m?.[1];
  if (!code) throw new Error(`no CONFIRM code in: ${stdout}`);
  return code;
}

test("codex fan-out: one confirmed tool_use_id allows sibling callbacks idempotently, then denies another id", async () => {
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("codex-fanout");
  const cmd = "git commit -m confirm-fanout";
  const denied = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), opts);
  const code = codeFromDeny(denied.stdout);
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });

  const first = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), { ...opts, now: 1200 });
  const sibling = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), { ...opts, now: 1201 });
  const distinct = await handleHook("codex", codexPre(s, cmd, "tool-b", workdir), { ...opts, now: 1202 });

  expect(first.stdout).not.toContain('"permissionDecision":"deny"');
  expect(sibling.stdout).not.toContain('"permissionDecision":"deny"');
  expect(JSON.parse(distinct.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("codex consumed confirmation text cannot re-arm without a new denial", async () => {
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("codex-submit-replay");
  const cmd = "git commit -m confirm-submit-replay";
  const denied = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), opts);
  const code = codeFromDeny(denied.stdout);
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
  await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), { ...opts, now: 1200 });
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1250 });
  const replay = await handleHook("codex", codexPre(s, cmd, "tool-b", workdir), { ...opts, now: 1300 });
  expect(JSON.parse(replay.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("codex command mismatch denies the OTHER command but keeps the armed action valid", async () => {
  const cmdA = "git commit -m confirm-action-a";
  const cmdB = "git commit -m confirm-action-b";
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("command-mismatch");
  const deniedA = await handleHook("codex", codexPre(s, cmdA, "tool-a", workdir), opts);
  const code = codeFromDeny(deniedA.stdout);
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
  const deniedB = await handleHook("codex", codexPre(s, cmdB, "tool-b", workdir), { ...opts, now: 1200 });
  expect(JSON.parse(deniedB.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(deniedB.stdout).toContain("rejection: mismatch");
  // Updated assertion (multi-pending mandate): the armed token A is NOT erased by B's denial.
  const allowedAAgain = await handleHook("codex", codexPre(s, cmdA, "tool-a", workdir), { ...opts, now: 1300 });
  expect(allowedAAgain.stdout).not.toContain('"permissionDecision":"deny"');
});

test("codex action identity canonicalizes argv/string transport and rejects a different cwd", async () => {
  const h = home();
  const workdir = cwd();
  const other = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s1 = sid("transport");
  const cmd = "git commit -m confirm-transport";
  const argv = { ...codexPre(s1, cmd, "tool-a", workdir), tool_input: { command: ["bash", "-lc", cmd] } };
  const denied = await handleHook("codex", argv, opts);
  const code = codeFromDeny(denied.stdout);
  await handleHook("codex", submit(s1, `CONFIRM ${code}`), { ...opts, now: 1100 });
  const allowed = await handleHook("codex", codexPre(s1, cmd, "tool-a", workdir), { ...opts, now: 1200 });
  expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');

  const s2 = sid("cwd");
  const deniedAtWorkdir = await handleHook("codex", codexPre(s2, cmd, "tool-b", workdir), opts);
  await handleHook("codex", submit(s2, `CONFIRM ${codeFromDeny(deniedAtWorkdir.stdout)}`), { ...opts, now: 1100 });
  const wrongCwd = await handleHook("codex", codexPre(s2, cmd, "tool-b", other), { ...opts, now: 1200 });
  expect(JSON.parse(wrongCwd.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(wrongCwd.stdout).toContain("rejection: mismatch");
});

test("codex diagnostics name rule, canonical command, expected token, and typed rejection", async () => {
  const workdir = cwd();
  const cmd = "prog log > out.txt";
  const out = await handleHook("codex", codexPre(sid("diagnostic"), cmd, "tool-a", workdir), { now: 1000, cwd: workdir, home: home() });
  expect(out.stdout).toContain("rule ID: bash-write:file-redirect");
  expect(out.stdout).toContain(`canonical command: ${cmd}`);
  expect(out.stdout).toMatch(/expected token: CONFIRM [0-9a-f]{4}/);
  expect(out.stdout).toContain("rejection: no-token");
});

test("codex UserPromptSubmit is wired and arms confirmation before scope early returns", async () => {
  const hooks = JSON.parse(codexInit("harness hook codex")[0]!.content) as { hooks: Record<string, unknown[]> };
  expect(hooks.hooks.UserPromptSubmit?.length).toBe(1);
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("scope-submit");
  const cmd = "git commit -m scope-submit";
  const denied = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), opts);
  const code = codeFromDeny(denied.stdout);
  await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100, scope: "rules" });
  const allowed = await handleHook("codex", codexPre(s, cmd, "tool-a", workdir), { ...opts, now: 1200 });
  expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');
});

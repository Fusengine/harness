import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

/**
 * Pins the REAL Codex sub-agent hook shape (codex-rs/core/src/hook_runtime.rs:
 * `session_id: sess.session_id()` = identity shared by the root thread and all
 * descendants; `agent_id` = the child THREAD id). A sub-agent's `session_id`
 * therefore already IS the root human session: no parent link is needed.
 */
const temp = (label: string): string => mkdtempSync(join(tmpdir(), `fh-${label}-`));
const DENY = '"permissionDecision":"deny"';

function setup() {
  const root = `root-${randomUUID()}`;
  const child = `child-${randomUUID()}`;
  const opts: HandleOptions = { now: 1000, cwd: temp("cx-sub-cwd"), home: temp("cx-sub-home") };
  /** Sub-agent shape: shared root session_id + own thread id in agent_id. */
  const sub = (command: string, toolUseId: string) => ({
    hook_event_name: "PreToolUse", session_id: root, agent_id: child, agent_type: "worker",
    tool_use_id: toolUseId, tool_name: "Bash", tool_input: { command },
  });
  const human = (code: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "UserPromptSubmit", session_id: root, prompt: `CONFIRM ${code}\n`, ...extra,
  });
  return { opts, sub, human };
}

const codeOf = (stdout: string): string => {
  const code = stdout.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
  if (!code) throw new Error(`missing CONFIRM code: ${stdout}`);
  return code;
};

test("child denied -> human CONFIRM in main session -> child retry allowed once, second retry denied", async () => {
  const { opts, sub, human } = setup();
  const cmd = "git commit -m child-gated";
  const denied = await handleHook("codex", sub(cmd, "t1"), opts);
  expect(denied.stdout).toContain(DENY);
  const code = codeOf(denied.stdout);
  const ack = await handleHook("codex", human(code), { ...opts, now: 1100 });
  expect(ack.stdout).not.toContain("unknown");
  expect((await handleHook("codex", sub(cmd, "t2"), { ...opts, now: 1200 })).stdout).not.toContain(DENY);
  expect((await handleHook("codex", sub(cmd, "t3"), { ...opts, now: 1300 })).stdout).toContain(DENY);
});

test("token for a different action is not usable by the child", async () => {
  const { opts, sub, human } = setup();
  const code = codeOf((await handleHook("codex", sub("git commit -m a", "t1"), opts)).stdout);
  await handleHook("codex", human(code), { ...opts, now: 1100 });
  expect((await handleHook("codex", sub("git commit -m b", "t2"), { ...opts, now: 1200 })).stdout).toContain(DENY);
});

test("a sub-agent prompt can never arm the token", async () => {
  const { opts, sub, human } = setup();
  const cmd = "git commit -m forged";
  const code = codeOf((await handleHook("codex", sub(cmd, "t1"), opts)).stdout);
  await handleHook("codex", human(code, { agent_id: "x", agent_type: "worker" }), { ...opts, now: 1100 });
  expect((await handleHook("codex", sub(cmd, "t2"), { ...opts, now: 1200 })).stdout).toContain(DENY);
});

test("fan-out: a sibling process re-acks the same CONFIRM -> never 'unknown', child retry still passes once", async () => {
  const { opts, sub, human } = setup();
  const cmd = "git commit -m fanout";
  const code = codeOf((await handleHook("codex", sub(cmd, "t1"), opts)).stdout);
  const first = await handleHook("codex", human(code), { ...opts, now: 1100 }); // process A arms
  const second = await handleHook("codex", human(code), { ...opts, now: 1100 }); // sibling process B, same prompt
  expect(first.stdout).toContain("accepted");
  expect(second.stdout).not.toContain("unknown");
  expect(second.stdout).toContain("accepted");
  expect((await handleHook("codex", sub(cmd, "t2"), { ...opts, now: 1200 })).stdout).not.toContain(DENY);
  expect((await handleHook("codex", sub(cmd, "t3"), { ...opts, now: 1300 })).stdout).toContain(DENY);
});

test("token expires after 5 minutes", async () => {
  const { opts, sub, human } = setup();
  const cmd = "git commit -m late";
  const code = codeOf((await handleHook("codex", sub(cmd, "t1"), opts)).stdout);
  await handleHook("codex", human(code), { ...opts, now: 1100 });
  expect((await handleHook("codex", sub(cmd, "t2"), { ...opts, now: 1100 + 5 * 60_000 + 1 })).stdout).toContain(DENY);
});

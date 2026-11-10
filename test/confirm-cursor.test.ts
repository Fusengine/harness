import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

const dir = (p: string): string => mkdtempSync(join(tmpdir(), p));

/** Real Cursor `preToolUse` shape (captured from cursor.hooks log): Shell tool, conversation_id === session_id. */
const pre = (s: string, command: string, cwd: string) => ({
  hook_event_name: "preToolUse", conversation_id: s, session_id: s, generation_id: randomUUID(),
  tool_name: "Shell", tool_use_id: randomUUID(), tool_input: { command }, cwd, workspace_roots: [cwd],
});
/** Real Cursor `beforeSubmitPrompt` shape: `prompt` is a plain string. */
const submit = (s: string, prompt: string, cwd: string) => ({
  hook_event_name: "beforeSubmitPrompt", conversation_id: s, session_id: s, generation_id: randomUUID(), prompt, workspace_roots: [cwd],
});

function codeFrom(stdout: string): string {
  const code = stdout.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
  if (!code) throw new Error(`no CONFIRM code in: ${stdout}`);
  return code;
}

test("cursor: an ask downgraded to deny now carries a CONFIRM code, and CONFIRM <code> allows the exact command once", async () => {
  const cwd = dir("fh-cc-cwd-");
  const opts: HandleOptions = { now: 1000, cwd, home: dir("fh-cc-home-") };
  const s = `cursor-${randomUUID()}`;
  const cmd = "git commit -m confirm-cursor";
  const denied = await handleHook("cursor", pre(s, cmd, cwd), opts);
  const d = JSON.parse(denied.stdout) as { permission: string; user_message: string; agent_message: string };
  expect(d.permission).toBe("deny");
  expect(d.agent_message).toContain("To allow, reply: CONFIRM ");
  await handleHook("cursor", submit(s, `CONFIRM ${codeFrom(denied.stdout)}`, cwd), { ...opts, now: 1100 });
  const allowed = await handleHook("cursor", pre(s, cmd, cwd), { ...opts, now: 1200 });
  expect(allowed.stdout).not.toContain("\"deny\"");
  const replay = await handleHook("cursor", pre(s, cmd, cwd), { ...opts, now: 1300 });
  expect(JSON.parse(replay.stdout).permission).toBe("deny");
});

test("cursor: a wrong code or a refusal never allows", async () => {
  const cwd = dir("fh-cc-cwd-");
  const opts: HandleOptions = { now: 1000, cwd, home: dir("fh-cc-home-") };
  const s = `cursor-${randomUUID()}`;
  const cmd = "git commit -m confirm-cursor-wrong";
  const code = codeFrom((await handleHook("cursor", pre(s, cmd, cwd), opts)).stdout);
  const wrong = ((parseInt(code, 16) + 1) % 0x10000).toString(16).padStart(4, "0");
  await handleHook("cursor", submit(s, `CONFIRM ${wrong}`, cwd), { ...opts, now: 1100 });
  expect(JSON.parse((await handleHook("cursor", pre(s, cmd, cwd), { ...opts, now: 1200 })).stdout).permission).toBe("deny");
  await handleHook("cursor", submit(s, `non, CONFIRM ${code}`, cwd), { ...opts, now: 1300 });
  expect(JSON.parse((await handleHook("cursor", pre(s, cmd, cwd), { ...opts, now: 1400 })).stdout).permission).toBe("deny");
});

test("cursor: a multi-candidate MCP call is never confirmable (a benign head cannot unlock an rm -rf candidate)", async () => {
  const cwd = dir("fh-cc-cwd-");
  const opts: HandleOptions = { now: 1000, cwd, home: dir("fh-cc-home-") };
  const s = `cursor-${randomUUID()}`;
  const mcp = { hook_event_name: "beforeMCPExecution", conversation_id: s, session_id: s, command: "ls", tool_input: { command: "rm -rf ./build" }, cwd, workspace_roots: [cwd] };
  const out = await handleHook("cursor", mcp, opts);
  expect(JSON.parse(out.stdout).permission).toBe("deny");
  expect(out.stdout).not.toContain("To allow");
});

test("cursor: an irreversible command (git push --force) is never offered a CONFIRM code", async () => {
  const cwd = dir("fh-cc-cwd-");
  const out = await handleHook("cursor", pre(`cursor-${randomUUID()}`, "git push --force origin main", cwd), { now: 1000, cwd, home: dir("fh-cc-home-") });
  expect(JSON.parse(out.stdout).permission).toBe("deny");
  expect(out.stdout).not.toContain("To allow");
});

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "../src/adapters/claude";
import { handleHook } from "../src/runtime/handle";
import { normalizeEvent } from "../src/runtime/normalize";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-redir-plumb-")));
const D = join(root, "claude-501", "-proj", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", "scratchpad");
mkdirSync(D, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMAND = `echo x > ${D}/out.log`;

function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse", session_id: `plumb-${randomUUID()}`, tool_use_id: randomUUID(), cwd: root,
    tool_name: "Bash", tool_input: { command: COMMAND }, ...extra,
  };
}

async function decision(id: string, extra: Record<string, unknown>): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "fh-redir-home-"));
  const out = await handleHook(id, payload(extra), { now: 1000, cwd: root, home }).finally(() => rmSync(home, { recursive: true, force: true }));
  if (!out.stdout) return "allow";
  const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return parsed.hookSpecificOutput?.permissionDecision ?? "allow";
}

describe("scratchpad_dir plumbing (Claude Code only)", () => {
  test("normalizeEvent carries scratchpad_dir for claude-code only", () => {
    expect(normalizeEvent("claude-code", payload({ scratchpad_dir: D })).scratchpadDir).toBe(D);
    for (const id of ["codex", "kimi", "cursor", "cline"]) {
      expect(normalizeEvent(id, payload({ scratchpad_dir: D })).scratchpadDir, id).toBeUndefined();
    }
    expect(normalizeEvent("claude-code", payload({})).scratchpadDir).toBeUndefined();
    expect(normalizeEvent("claude-code", payload({ scratchpad_dir: 42 })).scratchpadDir).toBeUndefined();
  });

  test("end to end: claude-code with scratchpad_dir allows, without it asks", async () => {
    expect(await decision("claude-code", { scratchpad_dir: D })).toBe("allow");
    expect(await decision("claude-code", {})).toBe("ask");
  });

  test("end to end: the same field on other hosts changes nothing", async () => {
    expect(await decision("codex", { scratchpad_dir: D })).toBe(await decision("codex", {}));
    expect(await decision("kimi", { scratchpad_dir: D })).toBe(await decision("kimi", {}));
  });

  test("a payload scratchpad_dir does not relax a project-file redirect", async () => {
    const cmd = { tool_input: { command: `echo x > ${root}/proj/notes.log` } };
    expect(await decision("claude-code", { scratchpad_dir: D, ...cmd })).toBe("ask");
  });

  test("legacy claude guard() adapter honours the field too", () => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: COMMAND } };
    expect(guard({ ...input, scratchpad_dir: D })).toBeNull();
    expect(guard(input)).not.toBeNull();
  });
});

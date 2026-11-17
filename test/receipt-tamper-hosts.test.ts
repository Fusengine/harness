/**
 * Host parity for the receipt-store / HMAC-key protection: the same Bash write is denied and the same read is allowed on
 * Claude Code, Codex, Kimi and Cursor (shared `runGuards` chain). `ask` is downgraded to deny on every host but Claude Code.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";
import { fuseHarnessHome } from "../src/runtime/home-state";

const ids = ["claude-code", "codex", "cursor", "kimi"] as const;
type Id = (typeof ids)[number];

/** Host-shaped hook payload for one Bash command (Cursor `beforeShellExecution`, others `PreToolUse`). */
function payload(id: Id, command: string, cwd: string): Record<string, unknown> {
  const session_id = `rt-hosts-${id}-${randomUUID()}`;
  if (id === "cursor") return { hook_event_name: "beforeShellExecution", session_id, command, cwd };
  return { hook_event_name: "PreToolUse", session_id, tool_use_id: randomUUID(), cwd, tool_name: "Bash", tool_input: { command } };
}

/** Permission decision from the host-specific hook stdout; empty stdout means allow. */
function decision(id: Id, stdout: string): string {
  if (!stdout) return "allow";
  const parsed = JSON.parse(stdout) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
  return id === "cursor" ? parsed.permission ?? "allow" : parsed.hookSpecificOutput?.permissionDecision ?? "allow";
}

test("receipt-store protection gives the same verdict on every host", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fh-rt-hosts-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "fh-rt-hosts-home-"));
  const h = fuseHarnessHome(home);
  const rows: ReadonlyArray<readonly [string, readonly [string, string, string, string]]> = [
    [`echo forged >> ${h}/state/ab/track-s.log`, ["deny", "deny", "deny", "deny"]],
    [`cp /tmp/a ${h}//.key 2>/dev/null`, ["deny", "deny", "deny", "deny"]],
    [`ln -sf /tmp/x ${h}/.key`, ["deny", "deny", "deny", "deny"]],
    [`rm -rf ${h}/state`, ["deny", "deny", "deny", "deny"]],
    [`find /tmp -exec cp {} ${h}/state \\;`, ["deny", "deny", "deny", "deny"]],
    [`cat ${h}/.key`, ["allow", "allow", "allow", "allow"]],
    [`grep -rn mv ${h}/state`, ["allow", "allow", "allow", "allow"]],
    [`cp -t /tmp ${h}/state/ab/track-s.json`, ["allow", "allow", "allow", "allow"]],
    [`cd ${h} && echo x > .key`, ["ask", "deny", "deny", "deny"]], // not resolved by the protected-path guard: bash-write asks (downgraded to deny off Claude Code)
  ];
  for (const [command, expected] of rows) {
    const actual = await Promise.all(ids.map(async (id) => decision(id, (await handleHook(id, payload(id, command, cwd), { now: 1000, cwd, home })).stdout)));
    expect(actual, command).toEqual([...expected]);
  }
});

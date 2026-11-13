/**
 * Verdict helpers for the monotonicity law: the bare Bash-write guard (sync) and the real
 * Claude Code hook path (`handleHook`, fresh session per call, isolated HOME/cwd).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../../src/runtime/handle";

/** Verdict ladder: a context must never lower it. */
export type Verdict = "allow" | "ask" | "block";

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, block: 2 };

/** True when `a` is strictly weaker than `b`. */
export function weaker(a: Verdict, b: Verdict): boolean {
  return RANK[a] < RANK[b];
}

/** A throwaway payload cwd holding an existing sub-directory `d` (so `cd d && …` is a cd that certainly succeeds). */
function freshCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-mono-cwd-"));
  mkdirSync(join(dir, "d"));
  return dir;
}

let sandbox: { cwd: string; home: string } | null = null;

/** Host ids whose hook output the pairing test decodes. */
export const HOSTS = ["claude-code", "codex", "kimi", "cursor"] as const;
/** One of {@link HOSTS}. */
export type HostId =(typeof HOSTS)[number];

/** Raw decision (`allow` | `ask` | `deny`) of the full hook chain on one host id. */
export async function hostDecision(id: HostId, command: string): Promise<string> {
  sandbox ??= {
    cwd: freshCwd(),
    home: mkdtempSync(join(tmpdir(), "fh-mono-home-")),
  };
  const session_id = `mono-${id}-${randomUUID()}`;
  const payload: Record<string, unknown> =
    id === "cursor"
      ? { hook_event_name: "beforeShellExecution", session_id, command, cwd: sandbox.cwd }
      : { hook_event_name: "PreToolUse", session_id, tool_use_id: randomUUID(), cwd: sandbox.cwd, tool_name: "Bash", tool_input: { command } };
  const out = await handleHook(id, payload, { now: 1000, cwd: sandbox.cwd, home: sandbox.home });
  if (!out.stdout) return "allow";
  const parsed = JSON.parse(out.stdout) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
  return id === "cursor" ? (parsed.permission ?? "allow") : (parsed.hookSpecificOutput?.permissionDecision ?? "allow");
}

/** Verdict of the full Claude Code hook chain (bash-write + security + git guards, ...). */
export async function hookVerdict(command: string): Promise<Verdict> {
  const d = await hostDecision("claude-code", command);
  return d === "deny" ? "block" : d === "ask" ? "ask" : "allow";
}

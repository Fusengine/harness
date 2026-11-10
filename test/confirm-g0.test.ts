import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleHook, type HandleOptions } from "../src/runtime/handle";
import { hashForAction } from "../src/runtime/confirm/confirm-code";
import { placeConfirmToken, consumeConfirmToken } from "../src/runtime/confirm/confirm-state";
import { isSubagentActive, markSubagentSeen } from "../src/runtime/confirm/confirm-subagent";
import { sessionStatePath } from "../src/runtime/home-state";

// Default G0 cool-down (FUSE_CONFIRM_SUBAGENT_WINDOW_SEC unset) — confirm-subagent.ts's DEFAULT_CONFIRM_WINDOW_SEC, in ms.
const SUBAGENT_WINDOW_MS = 5 * 60 * 1000;

const cwd = (): string => mkdtempSync(join(tmpdir(), "fh-confirm-g0-cwd-"));
const home = (): string => mkdtempSync(join(tmpdir(), "fh-confirm-g0-home-"));
const sid = (label: string): string => `${label}-${randomUUID()}`;

const pre = (id: string, s: string, command: string) => ({ hook_event_name: "PreToolUse", session_id: s, tool_use_id: randomUUID(), tool_name: "Bash", tool_input: { command } });
const submit = (s: string, prompt: string) => ({ hook_event_name: "UserPromptSubmit", session_id: s, prompt });

/** Extract the 4-hex-char code from a "To allow, reply: CONFIRM xxxx" deny message. */
function codeFromDeny(stdout: string): string {
  const m = stdout.match(/CONFIRM ([0-9a-f]{4})/i);
  const code = m?.[1];
  if (!code) throw new Error(`no CONFIRM code in: ${stdout}`);
  return code;
}

test("G0 unit: the cool-down is a monotone window, not a start/stop toggle — it only falls once SUBAGENT_WINDOW_MS has fully elapsed since the LAST sighting", () => {
  const h = home();
  const s = sid("g0-unit");
  expect(isSubagentActive(s, 1000, h)).toBe(false);
  markSubagentSeen(s, 1000, h); // SubagentStart
  expect(isSubagentActive(s, 1001, h)).toBe(true);
  placeConfirmToken(s, hashForAction("anything"), 1001, h); // must no-op (G0)
  expect(consumeConfirmToken(s, hashForAction("anything"), 1002, h)).toBe(false);
  markSubagentSeen(s, 1050, h); // SubagentStop — SAME max-write, no decrement, still active
  expect(isSubagentActive(s, 1051, h)).toBe(true);
  placeConfirmToken(s, hashForAction("anything"), 1051, h);
  expect(consumeConfirmToken(s, hashForAction("anything"), 1052, h)).toBe(false);
  // Only once the window has elapsed since the LAST sighting (1050) does the flag fall.
  const past = 1050 + SUBAGENT_WINDOW_MS + 1;
  expect(isSubagentActive(s, past, h)).toBe(false);
  placeConfirmToken(s, hashForAction("anything"), past, h);
  expect(consumeConfirmToken(s, hashForAction("anything"), past + 1, h)).toBe(true);
});

test("G0 wiring: explicit subagent prompts stay blocked while provenance-free root prompts bypass the cool-down", async () => {
  // Uses the REAL default OS home (no `home` override) because dispatch.ts's
  // SubagentStart/SubagentStop path does not thread HandleOptions.home — a
  // unique session id keeps this isolated from any other run/session. The
  // residual state file this writes to the real home is cleaned up in
  // `finally` (never leave orphaned files on the owner's machine).
  const opts: HandleOptions = { now: 1000, cwd: cwd() };
  const s = sid("g0-wiring");
  const cmd = "git commit -m confirm-g0-wiring";
  try {
    const denied = await handleHook("codex", pre("codex", s, cmd), opts);
    const code = codeFromDeny(denied.stdout);
    await handleHook("codex", { hook_event_name: "SubagentStart", session_id: s, agent_id: "a1", agent_type: "x" }, { ...opts, now: 1050 });
    await handleHook("codex", { ...submit(s, `CONFIRM ${code}`), agent_id: "a1", agent_type: "x" }, { ...opts, now: 1100 });
    const stillDenied = await handleHook("codex", pre("codex", s, cmd), { ...opts, now: 1200 });
    expect(JSON.parse(stillDenied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1225 });
    const allowedDuringStartCooldown = await handleHook("codex", pre("codex", s, cmd), { ...opts, now: 1230 });
    expect(allowedDuringStartCooldown.stdout.includes('"permissionDecision":"deny"')).toBe(false);

    await handleHook("codex", { hook_event_name: "SubagentStop", session_id: s, agent_id: "a1", agent_type: "x" }, { ...opts, now: 1250 });
    const cmdAfterStop = "git commit -m confirm-g0-after-stop";
    const deniedAfterStop = await handleHook("codex", pre("codex", s, cmdAfterStop), { ...opts, now: 1300 });
    const codeAfterStop = codeFromDeny(deniedAfterStop.stdout);
    await handleHook("codex", submit(s, `CONFIRM ${codeAfterStop}`), { ...opts, now: 1350 });
    const allowedAfterStop = await handleHook("codex", pre("codex", s, cmdAfterStop), { ...opts, now: 1400 });
    expect(allowedAfterStop.stdout.includes('"permissionDecision":"deny"')).toBe(false);
  } finally {
    rmSync(sessionStatePath(s), { force: true });
  }
});

test("G0 env override: FUSE_CONFIRM_SUBAGENT_WINDOW_SEC changes the cool-down window", () => {
  const h = home();
  const s = sid("g0-env-override");
  const oneSecWindow = { FUSE_CONFIRM_SUBAGENT_WINDOW_SEC: "1" };
  markSubagentSeen(s, 1000, h);
  // Under the 1s override, 1500ms later is still inside the window...
  expect(isSubagentActive(s, 1500, h, oneSecWindow)).toBe(true);
  // ...but 2001ms later is past it.
  expect(isSubagentActive(s, 2001, h, oneSecWindow)).toBe(false);
  // The SAME timestamps stay well inside the 300s DEFAULT when no override is passed —
  // proves the env key actually drives the value, not just a coincidental match.
  expect(isSubagentActive(s, 2001, h)).toBe(true);
  // The lever reaches placeConfirmToken too: under the override the window has
  // elapsed, so G0 no longer blocks and the token gets placed.
  placeConfirmToken(s, hashForAction("anything"), 2001, h, oneSecWindow);
  expect(consumeConfirmToken(s, hashForAction("anything"), 2002, h)).toBe(true);
});

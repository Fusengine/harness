import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomeStopGate } from "../src/runtime/lead-guards/outcome-stop-gate";
import { leadScopeGate } from "../src/runtime/lead-guards/scope-pre-gate";
import { ownerMessageText, turnStartedByOwner } from "../src/runtime/lead-guards/transcript-owner";
import { dispatchLifecycle } from "../src/runtime/lifecycle/dispatch";
import { handleHook } from "../src/runtime/handle";

type Row = Record<string, unknown>;
const owner = (text: string): Row => ({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text } });
const notif = (text = "<task-notification>done</task-notification>"): Row => ({ type: "user", origin: { kind: "task-notification" }, isMeta: true, message: { role: "user", content: text } });
const peer = (text: string): Row => ({ type: "user", origin: { kind: "peer" }, message: { role: "user", content: `Another Claude session sent a message: ${text}` } });
const toolResult = (text: string): Row => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] } });
const reminderOwner = (text: string): Row => ({
  type: "user",
  origin: { kind: "human" },
  message: { role: "user", content: [{ type: "text", text: '<system-reminder>\nThe session "Port workflow" is waiting\n</system-reminder>' }, { type: "text", text }] },
});
const reminderOnly = (): Row => ({ type: "user", message: { role: "user", content: '<system-reminder>\nThe session "Port workflow" is running\n</system-reminder>' } });
const queued = (prompt: string): Row => ({ type: "attachment", attachment: { type: "queued_command", humanTurn: true, origin: { kind: "human" }, prompt } });
const toolUse: Row = { type: "assistant", message: { id: "m0", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] } };
const final = (text: string, id = "m1"): Row => ({ type: "assistant", message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] } });
const thinkingStop = (id: string): Row => ({ type: "assistant", message: { id, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "..." }] } });

/** Write a JSONL transcript fixture and return its path. */
function transcript(rows: Row[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "lg-")), "t.jsonl");
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const STATUS = "Kimi finit encore ses derniers points, l'analyse tourne toujours. Je reviens au résultat final.";
const stop = (path: string, msg: string, extra: Row = {}): Row => ({ hook_event_name: "Stop", transcript_path: path, last_assistant_message: msg, stop_hook_active: false, ...extra });

describe("ownerMessageText", () => {
  test("accepts a human message, rejects every other user-role entry", () => {
    expect(ownerMessageText(owner("ok go"))).toBe("ok go");
    expect(ownerMessageText(notif())).toBeNull();
    expect(ownerMessageText(peer("hi"))).toBeNull();
    expect(ownerMessageText(toolResult("ok go"))).toBeNull();
    expect(ownerMessageText(owner("<bash-input>ls</bash-input>"))).toBeNull();
    expect(ownerMessageText(owner('  <pasted_content id="c5ab"> mon texte collé'))).not.toBeNull();
    expect(ownerMessageText({ type: "user", message: { content: "This session is being continued from a previous conversation" } })).toBeNull();
    expect(ownerMessageText({ type: "user", message: { content: "no origin field, plain text" } })).toBe("no origin field, plain text");
    expect(ownerMessageText({ type: "assistant", message: { content: "x" } })).toBeNull();
  });
});

describe("turnStartedByOwner", () => {
  test("owner message since the previous stop -> true", () => {
    expect(turnStartedByOwner(transcript([notif(), final("old"), owner("ça avance ?"), toolUse, toolResult("x"), final(STATUS, "m2")]))).toBe(true);
  });
  test("only a notification since the previous stop -> false", () => {
    expect(turnStartedByOwner(transcript([owner("lance"), final("old"), notif(), toolUse, final(STATUS, "m2")]))).toBe(false);
  });
  test("a peer relay is not the owner -> false", () => {
    expect(turnStartedByOwner(transcript([owner("lance"), final("old"), peer("done"), final(STATUS, "m2")]))).toBe(false);
  });
  test("thinking-only end_turn entry of the same turn is not a previous stop", () => {
    expect(turnStartedByOwner(transcript([owner("pourquoi ?"), thinkingStop("m1"), final(STATUS, "m1")]))).toBe(true);
  });
  test("transcript lag (final message not written yet) never yields a false negative", () => {
    expect(turnStartedByOwner(transcript([owner("lance"), final("old"), notif(), toolUse]))).toBe(true);
  });
  test("owner message behind a system-reminder block starts the turn", () => {
    expect(turnStartedByOwner(transcript([notif(), final("old"), reminderOwner("claude a été commit?"), final(STATUS, "m2")]))).toBe(true);
  });
  test("a message typed while the lead worked (queued_command) starts the turn", () => {
    expect(turnStartedByOwner(transcript([notif(), final("old"), notif(), toolUse, queued("tu te moque de moi"), final(STATUS, "m2")]))).toBe(true);
  });
  test("a reminder-only entry is a trigger (relay), not the owner", () => {
    expect(turnStartedByOwner(transcript([owner("lance"), final("old"), reminderOnly(), final(STATUS, "m2")]))).toBe(false);
  });
  test("no trigger evidence at all (opening message not flushed) -> never false", () => {
    expect(turnStartedByOwner(transcript([owner("lance"), final("old"), toolUse, final(STATUS, "m2")]))).toBe(true);
  });
  test("unreadable transcript -> null", () => {
    expect(turnStartedByOwner("/nonexistent/t.jsonl")).toBeNull();
  });
});

describe("outcomeStopGate", () => {
  const relay = (): string => transcript([owner("lance"), final("old"), notif(), toolUse, final(STATUS, "m2")]);
  test("status-only relay on a notification turn is blocked", () => {
    const out = JSON.parse(outcomeStopGate(stop(relay(), STATUS), "claude-code", {}));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("very short word");
  });
  test("same message but the owner started the turn -> allowed (an answer, not a relay)", () => {
    const p = transcript([notif(), final("old"), owner("ça avance ?"), final(STATUS, "m2")]);
    expect(outcomeStopGate(stop(p, STATUS), "claude-code", {})).toBe("");
  });
  test("outcome or owner action -> allowed", () => {
    const p = relay();
    expect(outcomeStopGate(stop(p, "PR #86 fusionnée, 427 tests réussis."), "claude-code", {})).toBe("");
    expect(outcomeStopGate(stop(p, "Je lance la release ?"), "claude-code", {})).toBe("");
  });
  test("stop_hook_active true -> never blocks twice in a row", () => {
    expect(outcomeStopGate(stop(relay(), STATUS, { stop_hook_active: true }), "claude-code", {})).toBe("");
  });
  test("sub-agent (agent_id), other harness, env off, no message, no transcript -> allowed", () => {
    const p = relay();
    expect(outcomeStopGate(stop(p, STATUS, { agent_id: "a1" }), "claude-code", {})).toBe("");
    expect(outcomeStopGate(stop(p, STATUS), "codex", {})).toBe("");
    expect(outcomeStopGate(stop(p, STATUS), "claude-code", { FUSE_LEAD_OUTCOME_GUARD: "0" })).toBe("");
    expect(outcomeStopGate(stop(p, ""), "claude-code", {})).toBe("");
    expect(outcomeStopGate({ last_assistant_message: STATUS }, "claude-code", {})).toBe("");
    expect(outcomeStopGate(stop("/nonexistent/t.jsonl", STATUS), "claude-code", {})).toBe("");
  });
  test("an answer to the owner's question is never a relay, even when it reads like one", () => {
    const msg = "Pas encore : le commit WIP tourne toujours, je te préviens dès qu'il est fait.";
    const p = transcript([notif(), final("old"), reminderOwner("claude a été commit?"), toolUse, final(msg, "m2")]);
    expect(outcomeStopGate(stop(p, msg), "claude-code", {})).toBe("");
  });
  test("the standby word the guard asks for is accepted", () => {
    expect(outcomeStopGate(stop(relay(), "waiting"), "claude-code", {})).toBe("");
    expect(outcomeStopGate(stop(relay(), "Waiting."), "claude-code", {})).toBe("");
  });
  test("dispatchLifecycle Stop (core scope) carries the block", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lg-cwd-"));
    const out = dispatchLifecycle({ event: "Stop", payload: { session_id: "s", ...stop(relay(), STATUS) }, cwd, scope: "core", now: Date.now() });
    expect(JSON.parse(out ?? "{}").decision).toBe("block");
  });
});

describe("leadScopeGate", () => {
  const tx = (): string => transcript([owner("ca doit etre garsantie"), toolUse, peer("« citation du pair »"), toolResult("« dans un résultat d'outil »")]);
  const brief = (q: string): string => `OWNER RULES (verbatim): ${q}\nWRITE: src/a.ts\nPROOF: bun test`;
  const agent = (prompt: string): Record<string, unknown> => ({ prompt });
  test("real owner quote passes", () => {
    expect(leadScopeGate("Agent", agent(brief("« ca doit etre garsantie »")), { transcript_path: tx() }, "claude-code", {})).toBeNull();
  });
  test("invented quote is denied", () => {
    const p = leadScopeGate("Agent", agent(brief("« le patron veut tout supprimer »")), { transcript_path: tx() }, "claude-code", {});
    expect(p?.kind).toBe("block");
    expect(p?.reason.split("\n")).toHaveLength(1);
  });
  test("quotes found only in a peer message or a tool result do not count", () => {
    expect(leadScopeGate("Agent", agent(brief("« citation du pair »")), { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
    expect(leadScopeGate("Agent", agent(brief("« dans un résultat d'outil »")), { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
  });
  test("brief without OWNER RULES is denied", () => {
    expect(leadScopeGate("Agent", agent("WRITE: x\nPROOF: y"), { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
  });
  test("no transcript_path -> nothing can be verified, never denied", () => {
    expect(leadScopeGate("Agent", agent("WRITE: x\nPROOF: y"), {}, "claude-code", {})).toBeNull();
  });
  test("lead helpers (explore/research/sniper/challenger) are exempt by subagent_type, with or without plugin prefix", () => {
    for (const t of ["fuse-ai-pilot:explore-codebase", "fuse-ai-pilot:research-expert", "fuse-ai-pilot:sniper", "fuse-ai-pilot:challenger", "Explore", "web-fetch", "claude-code-guide"]) {
      expect(leadScopeGate("Agent", { prompt: "WRITE: x", subagent_type: t }, { transcript_path: tx() }, "claude-code", {})).toBeNull();
    }
    expect(leadScopeGate("Agent", { prompt: "WRITE: x", subagent_type: "general-purpose" }, { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
    expect(leadScopeGate("Agent", { prompt: "WRITE: x", subagent_type: "fuse-typescript:typescript-expert" }, { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
  });
  test("owner words typed behind a system-reminder block or as a queued command count", () => {
    const p = transcript([reminderOwner("claude a été commit?"), queued("pas de régression sur le hook")]);
    expect(leadScopeGate("Agent", agent(brief("« claude a été commit? »")), { transcript_path: p }, "claude-code", {})).toBeNull();
    expect(leadScopeGate("Agent", agent(brief("« pas de régression sur le hook »")), { transcript_path: p }, "claude-code", {})).toBeNull();
  });
  test("a quote that only lives inside a system-reminder block is not the owner's", () => {
    const p = transcript([{ type: "user", origin: { kind: "human" }, message: { content: [{ type: "text", text: '<system-reminder>\nrappel « texte du rappel »\n</system-reminder>' }, { type: "text", text: "vas y" }] } }]);
    expect(leadScopeGate("Agent", agent(brief("« texte du rappel »")), { transcript_path: p }, "claude-code", {})?.kind).toBe("block");
  });
  test("SendMessage: short follow-up passes, a headed brief is checked", () => {
    expect(leadScopeGate("SendMessage", { to: "a", message: "continue" }, { transcript_path: tx() }, "claude-code", {})).toBeNull();
    const follow = "Follow-up on the running mandate.\nWRITE: src/a.ts\nPROOF: bun test\nREPORT: short";
    expect(leadScopeGate("SendMessage", { to: "a", message: follow }, { transcript_path: tx() }, "claude-code", {})).toBeNull();
    expect(leadScopeGate("SendMessage", { to: "a", message: brief("« faux faux »") }, { transcript_path: tx() }, "claude-code", {})?.kind).toBe("block");
    expect(leadScopeGate("SendMessage", { to: "a", message: brief("« ca doit etre garsantie »") }, { transcript_path: tx() }, "claude-code", {})).toBeNull();
  });
  test("sub-agent, other harness, env off, other tool, missing transcript -> inert / fail-open", () => {
    const bad = agent(brief("« faux faux »"));
    expect(leadScopeGate("Agent", bad, { agent_id: "a1", transcript_path: tx() }, "claude-code", {})).toBeNull();
    expect(leadScopeGate("Agent", bad, { transcript_path: tx() }, "codex", {})).toBeNull();
    expect(leadScopeGate("Agent", bad, { transcript_path: tx() }, "claude-code", { FUSE_LEAD_SCOPE_GUARD: "0" })).toBeNull();
    expect(leadScopeGate("Bash", { command: "x" }, { transcript_path: tx() }, "claude-code", {})).toBeNull();
    expect(leadScopeGate("Agent", bad, {}, "claude-code", {})).toBeNull();
    expect(leadScopeGate("Agent", bad, { transcript_path: "/nonexistent/t.jsonl" }, "claude-code", {})).toBeNull();
  });
  test("handleHook PreToolUse (core scope) denies a forged brief and lets a real one through", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lg-cwd-"));
    const base = { hook_event_name: "PreToolUse", tool_name: "Agent", session_id: "s-lg", cwd, transcript_path: tx() };
    const denied = await handleHook("claude-code", { ...base, tool_input: agent(brief("« faux faux »")) }, { now: Date.now(), cwd, scope: "core", home: cwd });
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const passed = await handleHook("claude-code", { ...base, tool_input: agent(brief("« ca doit etre garsantie »")) }, { now: Date.now(), cwd, scope: "core", home: cwd });
    expect(passed.stdout).not.toContain("lead-scope-guard");
    expect(passed.stdout).not.toContain("Brief without");
  });
});

/**
 * Cursor runs the harness TWICE per Shell command — `preToolUse` (tool Shell) then
 * `beforeShellExecution` — and a deny from either wins. A CONFIRM token consumed by
 * the first pass must stay valid for the sibling pass of the SAME command in the SAME
 * `generation_id` (user turn) for a few seconds; nothing else changes (Kimi strict).
 * Plus: while the G0 sub-agent freeze is on, a Cursor deny says so (it used to be silent).
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { consumeConfirmToken, placeConfirmToken } from "../src/runtime/confirm/confirm-state";
import { confirmGate } from "../src/runtime/confirm/confirm-gate";
import { markSubagentSeen } from "../src/runtime/confirm/confirm-subagent";
import { hashForAction } from "../src/runtime/confirm/confirm-code";
import type { Prompt } from "../src/prompt/types";

const home = (): string => mkdtempSync(join(tmpdir(), "fh-ccs-home-"));
const sid = (): string => `cursor-${randomUUID()}`;
const NOW = 1_800_000_000_000;
const ASK: Prompt = { kind: "ask", title: "Confirm git operation", reason: "git commit needs confirmation", actions: [] };
const CMD = "git commit -m sibling";

test("grace: the sibling pass (same hash, same generation, < 10 s) is allowed; later, another turn or another hash is not", () => {
  const h = home(), s = sid(), hash = hashForAction(CMD);
  placeConfirmToken(s, hash, NOW, h, {});
  const g = { ms: 10_000, generationId: "gen-1" };
  expect(consumeConfirmToken(s, hashForAction("git commit -m other"), NOW + 50, h, g)).toBe(false); // other command: token untouched
  expect(consumeConfirmToken(s, hash, NOW + 100, h, g)).toBe(true); // preToolUse
  expect(consumeConfirmToken(s, hash, NOW + 200, h, g)).toBe(true); // beforeShellExecution (the one sibling pass)
  expect(consumeConfirmToken(s, hash, NOW + 300, h, g)).toBe(false); // a 3rd run of the same command: denied
});

test("grace is one pass only, and only for the same turn", () => {
  const h = home(), s = sid(), hash = hashForAction(CMD);
  placeConfirmToken(s, hash, NOW, h, {});
  const g = { ms: 10_000, generationId: "gen-1" };
  expect(consumeConfirmToken(s, hash, NOW + 100, h, g)).toBe(true);
  expect(consumeConfirmToken(s, hash, NOW + 200, h, { ...g, generationId: "gen-2" })).toBe(false); // next turn: dropped
  expect(consumeConfirmToken(s, hash, NOW + 300, h, g)).toBe(false); // gone for good
});

test("grace expires: a pass more than 10 s after consumption is denied", () => {
  const h = home(), s = sid(), hash = hashForAction(CMD);
  placeConfirmToken(s, hash, NOW, h, {});
  const g = { ms: 10_000, generationId: "gen-1" };
  expect(consumeConfirmToken(s, hash, NOW + 100, h, g)).toBe(true);
  expect(consumeConfirmToken(s, hash, NOW + 10_101 + 100, h, g)).toBe(false);
});

test("no grace (Kimi and every non-Cursor caller): strictly one-shot, unchanged", () => {
  const h = home(), s = sid(), hash = hashForAction(CMD);
  placeConfirmToken(s, hash, NOW, h, {});
  expect(consumeConfirmToken(s, hash, NOW + 100, h)).toBe(true);
  expect(consumeConfirmToken(s, hash, NOW + 200, h)).toBe(false);
});

test("confirmGate: cursor pair allowed within one generation; kimi second pass denied; cursor without generation_id stays one-shot", () => {
  for (const [id, gen, second] of [["cursor", "gen-A", true], ["kimi", "gen-A", false], ["cursor", undefined, false]] as const) {
    const h = home(), s = sid();
    placeConfirmToken(s, hashForAction(CMD), NOW, h, {});
    expect(confirmGate(id, ASK, CMD, s, NOW + 100, h, undefined, gen)?.allow).toBe(true);
    expect(confirmGate(id, ASK, CMD, s, NOW + 200, h, undefined, gen)?.allow).toBe(second);
  }
});

test("frozen hint: a Cursor deny during the sub-agent freeze says until when; Kimi's message is unchanged", () => {
  const h = home(), s = sid();
  markSubagentSeen(s, NOW - 1000, h);
  const cursor = confirmGate("cursor", ASK, CMD, s, NOW, h, undefined, "gen-F");
  expect(cursor?.allow).toBe(false);
  expect(cursor && !cursor.allow ? cursor.prompt.reason : "").toContain("Confirmation frozen (sub-agent active) until");
  const kimi = confirmGate("kimi", ASK, CMD, s, NOW, h);
  expect(kimi && !kimi.allow ? kimi.prompt.reason : "").not.toContain("frozen");
  // No sub-agent seen → no hint.
  const quiet = confirmGate("cursor", ASK, CMD, sid(), NOW, h, undefined, "gen-F");
  expect(quiet && !quiet.allow ? quiet.prompt.reason : "").not.toContain("frozen");
});

test("end to end (real CLI, isolated HOME): CONFIRM then preToolUse + beforeShellExecution of the same command both pass; the next turn is denied", () => {
  const h = home(), cwd = mkdtempSync(join(tmpdir(), "fh-ccs-cwd-")), s = sid(), gen = randomUUID();
  const bin = join(import.meta.dir, "..", "src", "cli", "bin.ts");
  const run = (payload: Record<string, unknown>): string =>
    Bun.spawnSync(["bun", bin, "hook", "cursor", "core"], { cwd, env: { PATH: process.env.PATH ?? "", HOME: h }, stdin: Buffer.from(JSON.stringify(payload)), timeout: 30_000 }).stdout.toString();
  const base = { conversation_id: s, session_id: s, workspace_roots: [cwd] };
  const pre = (g: string) => ({ ...base, generation_id: g, hook_event_name: "preToolUse", tool_name: "Shell", tool_use_id: randomUUID(), tool_input: { command: CMD }, cwd });
  const shell = (g: string) => ({ ...base, generation_id: g, hook_event_name: "beforeShellExecution", command: CMD, cwd });
  const denied = run(pre(randomUUID()));
  const code = denied.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
  expect(code).toBeDefined();
  run({ ...base, generation_id: gen, hook_event_name: "beforeSubmitPrompt", prompt: `CONFIRM ${code}` });
  expect(run(pre(gen))).not.toContain('"deny"');
  expect(run(shell(gen))).not.toContain('"deny"');
  expect(JSON.parse(run(pre(randomUUID()))).permission).toBe("deny");
}, 60_000);

import { describe, test, expect, afterEach } from "bun:test";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { dedupeUnits, visibleHead } from "../src/runtime/inject-session/recall";
import { LOADER_ENV, isLoaderChild, registrationEnv } from "../src/runtime/inject-session/loader-child";
import { contextResponse } from "../src/adapters/claude";
import { body, cleanup, ctxOf, inp, tmp } from "./inject-session-helpers";

afterEach(() => { cleanup(); delete process.env[LOADER_ENV]; });
const ups = (st: string, i: number, extra: object = {}) => inp(st, "UserPromptSubmit", { now: 100_000 * (i + 1), extra: { prompt: `prompt ${i}` }, ...extra });

describe("recall: every prompt shows at least what HEAD showed", () => {
  test("inline block: byte-identical to HEAD on every prompt", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(7000, "L"));
    for (let i = 0; i < 4; i++) expect(filterClaudeContext(out, ups(st, i))).toBe(out);
  });
  test("spilled block: the exact 2 000-char head HEAD kept, on every prompt, within the 9 500 budget", () => {
    const st = tmp();
    const text = body(30_000, "R");
    const out = contextResponse("UserPromptSubmit", text);
    for (let i = 0; i < 6; i++) {
      const c = ctxOf(filterClaudeContext(out, ups(st, i)));
      expect(c.startsWith(text.slice(0, 2000))).toBe(true);
      expect(c.length).toBeLessThanOrEqual(9500);
    }
    expect(ctxOf(filterClaudeContext(out, ups(st, 9))).length).toBe(2000);
  });
  test("L1: same prompt text resent (new prompt_id) within 800 ms is recalled in full; a sibling with the SAME prompt_id is the only duplicate", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000, "D"));
    const at = (id: string | undefined, scope = "rules") => inp(st, "UserPromptSubmit", { now: 5000, scope, extra: { prompt: "continue", ...(id ? { prompt_id: id } : {}) } });
    expect(filterClaudeContext(out, at("p-1"))).toBe(out);
    expect(filterClaudeContext(out, at("p-1", "aipilot"))).toBe("");
    expect(filterClaudeContext(out, at("p-2"))).toBe(out); // same text, 0 ms later, new prompt_id
    expect(filterClaudeContext(out, at(undefined))).toBe(out); // no prompt_id: HEAD behaviour, never suppressed
    expect(filterClaudeContext(out, at(undefined, "aipilot"))).toBe(out);
    const p = `X ${"x".repeat(1300)}`;
    expect(dedupeUnits(`${p}\n\n${p}\n\nend`)).toBe(`${p}\n\nend`);
  });
  test("visibleHead: inline as is, spilled prefix", () => {
    expect(visibleHead("a".repeat(9000))).toHaveLength(9000);
    expect(visibleHead("a".repeat(10_001))).toHaveLength(2000);
  });
});

describe("L2: the loader copy drops a prompt's block ONLY when the native copy recalled it for THIS prompt_id", () => {
  const loader = { isLoaderChild: () => true };
  const at = (st: string, id: string | undefined, extra: object = {}) => inp(st, "UserPromptSubmit", { now: 5000, extra: { prompt: "implement", ...(id ? { prompt_id: id } : {}) }, ...extra });
  test("native first (same prompt_id): loader silent; other prompt_id or no native: loader prints HEAD's block", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000, "K"));
    expect(filterClaudeContext(out, at(st, "p-1"))).toBe(out);
    expect(filterClaudeContext(out, at(st, "p-1", loader))).toBe("");
    expect(filterClaudeContext(out, at(st, "p-2", loader))).toBe(out); // units are "known" from p-1, yet p-2 must still show them
    expect(filterClaudeContext(out, at(st, undefined, loader))).toBe(out);
  });
  test("loader copy running BEFORE the native copy prints the block (no loss); native then recalls too", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000, "Q"));
    expect(filterClaudeContext(out, at(st, "p-9", loader))).toBe(out);
    expect(filterClaudeContext(out, at(st, "p-9"))).toBe(out);
  });
});

describe("rendezvous registrations carry their own loader-vs-native answer", () => {
  test("env override wins over the process's own parent probe", () => {
    process.env[LOADER_ENV] = "1";
    expect(isLoaderChild()).toBe(true);
    process.env[LOADER_ENV] = "0";
    expect(isLoaderChild()).toBe(false);
  });
  test("registrationEnv stamps claude-code only", () => {
    expect(registrationEnv("codex", { A: "1" })).toEqual({ A: "1" });
    expect(["0", "1"]).toContain(registrationEnv("claude-code", { A: "1" })[LOADER_ENV] ?? "");
  });
});

describe("drain-only events skip the loader probe when nothing is parked", () => {
  test("PostToolUse with an empty park never calls isLoaderChild and returns stdout unchanged", () => {
    let probed = 0;
    const out = contextResponse("PostToolUse", "tool note");
    const res = filterClaudeContext(out, inp(tmp(), "PostToolUse", { isLoaderChild: () => { probed++; return false; } }));
    expect(res).toBe(out);
    expect(probed).toBe(0);
  });
});

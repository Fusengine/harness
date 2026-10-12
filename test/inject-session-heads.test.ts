import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { loaderOrder } from "../src/runtime/inject-session/ownership";
import { trimOverlap } from "../src/runtime/inject-session/recall";
import { contextResponse } from "../src/adapters/claude";
import { body, cleanup, ctxOf, inp, tmp } from "./inject-session-helpers";

afterEach(cleanup);

/** Loader-child input where a native copy provably runs; `order` is the loader's merge order at the event. */
const nativeAt = (st: string, scope: string, order: string[], event = "SubagentStart") =>
  inp(st, event, { scope, now: 1, extra: { agent_id: "a1", agent_type: "x" }, isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 1, native: true }), order: () => order });

describe("FIX 1: a native-backed loader child prints the part of its block that sat inside HEAD's 2 000-char merged preview", () => {
  test("first in the loader's merge order (lessons before rules at SubagentStart): its first 2 000 chars", () => {
    const st = tmp();
    const text = body(7800, "L");
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", text), nativeAt(st, "lessons", ["lessons", "rules"])))).toBe(text.slice(0, 2000));
  });
  test("a shorter native-backed block before it eats the preview: only the rest of the 2 000 chars is owed", () => {
    const st = tmp();
    const a = "A".repeat(1500);
    const text = body(7800, "L");
    const order = ["aipilot", "lessons", "rules"];
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", a), nativeAt(st, "aipilot", order)))).toBe(a);
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", text), nativeAt(st, "lessons", order)))).toBe(text.slice(0, 2000 - 1500 - 2));
  });
  test("a block that already fills the preview before it (core at UserPromptSubmit-like sizes): nothing is owed", () => {
    const st = tmp();
    const order = ["aipilot", "lessons"];
    filterClaudeContext(contextResponse("SubagentStart", "A".repeat(3000)), nativeAt(st, "aipilot", order));
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "L")), nativeAt(st, "lessons", order)))).toBe("");
  });
  test("a loader-only owner that precedes it counts too (its ORIGINAL block, as HEAD merged it)", () => {
    const st = tmp();
    const order = ["rules", "lessons"];
    const owner = inp(st, "SubagentStart", { scope: "rules", now: 1, extra: { agent_id: "a1", agent_type: "x" }, isLoaderChild: () => true, ownership: () => ({ owner: true, owners: 1, native: false }), order: () => order });
    filterClaudeContext(contextResponse("SubagentStart", body(30_000, "R")), owner);
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "L")), nativeAt(st, "lessons", order)))).toBe("");
  });
  test("UserPromptSubmit and SessionStart: still silent (that block sat beyond the preview)", () => {
    const st = tmp();
    for (const ev of ["UserPromptSubmit", "SessionStart"]) {
      expect(ctxOf(filterClaudeContext(contextResponse(ev, body(7800, "L")), nativeAt(st, "lessons", ["lessons"], ev)))).toBe("");
    }
  });
  test("unknown merge order: one head slot per recipient (bounded), as before", () => {
    const st = tmp();
    const at = (scope: string) => nativeAt(st, scope, []);
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "L")), at("lessons"))).length).toBe(2000);
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "A")), at("aipilot")))).toBe("");
  });
  test("the native copy already delivered the block: the loader child stays silent whatever the order", () => {
    const st = tmp();
    const text = body(7800, "L");
    filterClaudeContext(contextResponse("SubagentStart", text), inp(st, "SubagentStart", { scope: "lessons", now: 1, extra: { agent_id: "a1" } }));
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", text), nativeAt(st, "lessons", ["lessons"])))).toBe("");
  });
});

describe("loaderOrder: the hooks-loader's merge order (plugin dir listing order, then hooks.json order, matcher on agent_type)", () => {
  test("scopes registered for the event in directory order; a non-matching agent_type matcher drops the registration", () => {
    const home = tmp();
    const dir = join(home, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins");
    const defs: Record<string, Array<{ matcher: string; cmd: string }>> = {
      "p-lessons": [{ matcher: "", cmd: "lessons" }],
      "p-rules": [{ matcher: "", cmd: "rules" }],
      "p-apex": [{ matcher: "^(?!fusemail$)", cmd: "aipilot" }],
    };
    for (const [d, regs] of Object.entries(defs)) {
      mkdirSync(join(dir, d, "hooks"), { recursive: true });
      const groups = regs.map((r) => ({ matcher: r.matcher, hooks: [{ type: "command", command: `bun x hook claude-code ${r.cmd}` }] }));
      writeFileSync(join(dir, d, "hooks", "hooks.json"), JSON.stringify({ hooks: { SubagentStart: groups } }));
    }
    const listed = readdirSync(dir).map((d) => defs[d]?.[0]?.cmd ?? "");
    expect(loaderOrder(home, "SubagentStart", "other")).toEqual(listed);
    expect(loaderOrder(home, "SubagentStart", "fusemail")).toEqual(listed.filter((s) => s !== "aipilot"));
    expect(loaderOrder(home, "UserPromptSubmit", "")).toEqual([]);
    expect(loaderOrder(tmp(), "SubagentStart", "x")).toEqual([]);
  });
});

describe("FIX 2: no paragraph appears twice in one prompt's field (recalled head vs first undelivered chunk)", () => {
  const owner = { isLoaderChild: () => true, ownership: () => ({ owner: true, owners: 2, native: false }) };
  const marks = (c: string): string[] => [...c.matchAll(/(?:^|\n)R(\d+) /g)].map((m) => m[1] ?? "");
  test("loader owner: every prompt's field is a clean continuation of the head (no repeated paragraph), nothing lost across prompts", () => {
    const st = tmp();
    const text = body(30_000, "R");
    const out = contextResponse("UserPromptSubmit", text);
    const all: string[] = [];
    for (let i = 0; i < 40; i++) {
      const c = ctxOf(filterClaudeContext(out, inp(st, "UserPromptSubmit", { scope: "rules", now: 1, extra: { prompt_id: `p${i}`, prompt: "x" }, ...owner })));
      expect(c.startsWith(text.slice(0, 2000))).toBe(true);
      const m = marks(c);
      expect(new Set(m).size).toBe(m.length);
      all.push(c);
    }
    expect(all[0]?.length).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) expect(all.join("\n\n")).toContain(`R${i} `);
  });
  test("native spilled recall: same", () => {
    const st = tmp();
    const text = body(30_000, "R");
    const out = contextResponse("UserPromptSubmit", text);
    for (let i = 0; i < 12; i++) {
      const c = ctxOf(filterClaudeContext(out, inp(st, "UserPromptSubmit", { scope: "rules", now: 100_000 * (i + 1), extra: { prompt_id: `n${i}`, prompt: "x" } })));
      expect(c.startsWith(text.slice(0, 2000))).toBe(true);
      const m = marks(c);
      expect(new Set(m).size).toBe(m.length);
    }
  });
  test("trimOverlap: rest inside the head vanishes, rest straddling it continues the head exactly, unrelated rest is joined as a new paragraph", () => {
    const text = body(6000, "R");
    const head = text.slice(0, 2000);
    expect(trimOverlap(head, text.slice(0, 1222))).toBe(head);
    expect(trimOverlap(head, text.slice(1224, 3000))).toBe(text.slice(0, 3000));
    const later = text.slice(text.indexOf("R7 "), text.indexOf("R9 "));
    expect(trimOverlap(head, later)).toBe(`${head}\n\n${later}`);
    expect(trimOverlap(head, "")).toBe(head);
  });
});

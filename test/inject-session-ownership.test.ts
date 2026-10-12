import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loaderOwnership } from "../src/runtime/inject-session/ownership";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { contextResponse } from "../src/adapters/claude";
import { body, cleanup, ctxOf, inp, tmp } from "./inject-session-helpers";

afterEach(cleanup);

/** Fake marketplace plugin: `<home>/.claude/plugins/marketplaces/mk/plugins/<dir>` with plugin.json name + hooks registering `events: scope-args`. */
function plugin(home: string, dir: string, name: string, events: Record<string, string[]>): void {
  const root = join(home, ".claude", "plugins", "marketplaces", "mk", "plugins", dir);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  const hooks: Record<string, unknown> = {};
  for (const [ev, cmds] of Object.entries(events)) hooks[ev] = [{ matcher: "", hooks: cmds.map((c) => ({ type: "command", command: `bun $HOME/x/bin.mjs hook claude-code${c ? ` ${c}` : ""}` })) }];
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks }));
}
/** Home with rules/core registered on UPS but NOT enabled, lessons enabled. */
function realTopology(): { home: string; proj: string } {
  const home = tmp();
  const proj = tmp();
  plugin(home, "claude-rules", "fuse-rules", { UserPromptSubmit: ["rules"], SessionStart: ["rules"] });
  plugin(home, "core-guards", "core-guards", { UserPromptSubmit: [""], SessionStart: ["core"], PreToolUse: [""] });
  plugin(home, "fuse-lessons", "fuse-lessons", { UserPromptSubmit: ["lessons"] });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "fuse-lessons@mk": true, "other@mk": true } }));
  return { home, proj };
}

describe("ownership: a scope is native iff an ENABLED plugin registers it for that event", () => {
  test("rules and core run only through the loader; lessons has a native copy", () => {
    const { home, proj } = realTopology();
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "rules")).toEqual({ owner: true, owners: 2, native: false });
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "core")).toEqual({ owner: true, owners: 2, native: false });
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "lessons").owner).toBe(false);
  });
  test("project/local settings override: enabling the plugin makes it native; undeterminable settings never claim ownership", () => {
    const { home, proj } = realTopology();
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "fuse-rules@mk": true } }));
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "rules").owner).toBe(false);
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "core")).toEqual({ owner: true, owners: 1, native: false });
    writeFileSync(join(proj, ".claude", "settings.local.json"), "{broken");
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "core").owner).toBe(false);
  });
});

describe("ownership: native flag and cache version order", () => {
  test("native is true for a scope an ENABLED plugin registers; cache picks 1.0.14 over 1.0.9", () => {
    const { home, proj } = realTopology();
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "lessons")).toEqual({ owner: false, owners: 2, native: true });
    expect(loaderOwnership(home, proj, "UserPromptSubmit", "rules").native).toBe(false);
    const cache = join(home, ".claude", "plugins", "cache", "mk", "fuse-rules");
    for (const [v, scope] of [["1.0.9", "rules"], ["1.0.14", "lessons"]] as const) {
      mkdirSync(join(cache, v, "hooks"), { recursive: true });
      writeFileSync(join(cache, v, "hooks", "hooks.json"), JSON.stringify({ hooks: { SubagentStart: [{ matcher: "", hooks: [{ type: "command", command: `bun x hook claude-code ${scope}` }] }] } }));
    }
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "fuse-lessons@mk": true, "fuse-rules@mk": true } }));
    expect(loaderOwnership(home, proj, "SubagentStart", "lessons").native).toBe(true); // 1.0.14 is the installed one
    expect(loaderOwnership(home, proj, "SubagentStart", "rules").native).toBe(false);
  });
});

describe("ownership honours tool matchers on tool events", () => {
  test("an enabled plugin matching only Write|Edit leaves core loader-only for Read, native for Write", () => {
    const home = tmp();
    const proj = tmp();
    const hookWith = (matcher: string): Record<string, unknown> => ({ PostToolUse: [{ matcher, hooks: [{ type: "command", command: "bun x hook claude-code" }] }] });
    for (const [dir, name, matcher] of [["core-guards", "core-guards", ""], ["nextjs", "fuse-nextjs", "Write|Edit"]] as const) {
      const root = join(home, ".claude", "plugins", "marketplaces", "mk", "plugins", dir);
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      mkdirSync(join(root, "hooks"), { recursive: true });
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
      writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: hookWith(matcher) }));
    }
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "fuse-nextjs@mk": true } }));
    expect(loaderOwnership(home, proj, "PostToolUse", "core", "Read").owner).toBe(true);
    expect(loaderOwnership(home, proj, "PostToolUse", "core", "Write").owner).toBe(false);
  });
});

describe("loader-owner mode: the loader copy is THE owner when no native copy exists", () => {
  const own = (owners = 2) => ({ isLoaderChild: () => true, ownership: () => ({ owner: true, owners, native: false }) });
  const ups = (st: string, scope: string, id: string, o = own()) => inp(st, "UserPromptSubmit", { scope, now: 1, extra: { prompt_id: id, prompt: "x" }, ...o });
  test("UPS: HEAD's 2 000-char head every prompt + a bounded slice of the rest; the whole block is delivered over successive prompts", () => {
    const st = tmp();
    const text = body(30_000, "R");
    const out = contextResponse("UserPromptSubmit", text);
    const got: string[] = [];
    for (let i = 0; i < 40; i++) {
      const c = ctxOf(filterClaudeContext(out, ups(st, "rules", `p${i}`)));
      expect(c.startsWith(text.slice(0, 2000))).toBe(true);
      expect(c.length).toBeLessThanOrEqual(4100);
      got.push(c);
    }
    for (let i = 0; i < 60; i++) expect(got.join("\n\n")).toContain(`R${i} `);
    expect(got[39]?.length).toBe(2000);
  });
  test("chunks parked at SessionStart are small enough for the per-prompt slice: no head-of-line starvation", () => {
    const st = tmp();
    const text = body(30_000, "T");
    const seen: string[] = [ctxOf(filterClaudeContext(contextResponse("SessionStart", text), inp(st, "SessionStart", { scope: "rules", now: 1, extra: { source: "startup" }, ...own() })))];
    for (let i = 0; i < 30; i++) seen.push(ctxOf(filterClaudeContext(contextResponse("UserPromptSubmit", text), ups(st, "rules", `q${i}`))));
    for (let i = 0; i < 60; i++) expect(seen.join("\n\n")).toContain(`T${i} `);
  });
  test("two loader owners together stay under 9 500 chars per prompt (the loader merges them into one field)", () => {
    const st = tmp();
    const rules = contextResponse("UserPromptSubmit", body(30_000, "R"));
    const core = contextResponse("UserPromptSubmit", body(9000, "C"));
    for (let i = 0; i < 6; i++) {
      const a = ctxOf(filterClaudeContext(rules, ups(st, "rules", `p${i}`)));
      const b = ctxOf(filterClaudeContext(core, ups(st, "core", `p${i}`)));
      expect(a.length + b.length + 2).toBeLessThanOrEqual(9500);
    }
  });
  test("SessionStart: first chunk within the owner share, rest parked and drained by PostToolUse within the share", () => {
    const st = tmp();
    const out = contextResponse("SessionStart", body(30_000, "S"));
    const first = ctxOf(filterClaudeContext(out, inp(st, "SessionStart", { scope: "rules", now: 1, extra: { source: "startup" }, ...own() })));
    expect(first.length).toBeLessThanOrEqual(4000);
    const next = ctxOf(filterClaudeContext("", inp(st, "PostToolUse", { scope: "rules", now: 2, ...own() })));
    expect(next.length).toBeGreaterThan(0);
    expect(next.length).toBeLessThanOrEqual(4000);
  });
  test("a loader copy whose scope HAS a native copy keeps the old behaviour (prints HEAD's block unless the native recalled it)", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000, "L"));
    expect(filterClaudeContext(out, ups(st, "lessons", "p1", { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 2, native: false }) }))).toBe(out);
  });
  test("LOADER-FIRST RACE: a non-owner loader child whose scope HAS a native copy never prints, whatever the registry holds", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(7800, "L"));
    const nativeProven = { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 2, native: true }) };
    expect(filterClaudeContext(out, ups(st, "lessons", "p1", nativeProven))).toBe("");
    const o = contextResponse("SessionStart", body(7800, "L"));
    expect(ctxOf(filterClaudeContext(o, inp(st, "SessionStart", { scope: "lessons", now: 1, extra: { source: "startup" }, ...nativeProven })))).toBe("");
  });
  test("SubagentStart: a native-backed loader child still prints the part HEAD showed in the merged preview (native may have failed)", () => {
    const st = tmp();
    const text = body(7800, "L");
    const out = contextResponse("SubagentStart", text);
    const nativeProven = { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 1, native: true }) };
    const at = (scope: string) => inp(st, "SubagentStart", { scope, now: 1, extra: { agent_id: "a1" }, ...nativeProven });
    expect(ctxOf(filterClaudeContext(out, at("lessons")))).toBe(text.slice(0, 2000)); // native silent so far: HEAD's preview part is kept
    expect(ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "A")), at("aipilot")))).toBe(""); // one native head slot per recipient: never an unbounded merge
    // native copy delivered first: nothing to repeat
    const st2 = tmp();
    const sub = { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 1, native: true }) };
    filterClaudeContext(out, inp(st2, "SubagentStart", { scope: "lessons", now: 1, extra: { agent_id: "a1" } })); // the native copy
    expect(ctxOf(filterClaudeContext(out, inp(st2, "SubagentStart", { scope: "lessons", now: 1, extra: { agent_id: "a1" }, ...sub })))).toBe("");
  });
  test("SubagentStart owner share leaves room for that native head: owner + native head stay under 9 500", () => {
    const st = tmp();
    const own = { isLoaderChild: () => true, ownership: () => ({ owner: true, owners: 2, native: false }) };
    const nat = { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 2, native: true }) };
    const sub = { extra: { agent_id: "a1" } };
    const a = ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(30_000, "R")), inp(st, "SubagentStart", { scope: "rules", now: 1, ...sub, ...own })));
    const b = ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(9000, "C")), inp(st, "SubagentStart", { scope: "core", now: 1, ...sub, ...own })));
    const c = ctxOf(filterClaudeContext(contextResponse("SubagentStart", body(7800, "L")), inp(st, "SubagentStart", { scope: "lessons", now: 1, ...sub, ...nat })));
    expect([a, b, c].filter(Boolean).join("\n\n").length).toBeLessThanOrEqual(9500);
  });
  test("merged loader field stays under the cap in the loader-first order: owners' budget plus a silent native-backed child", () => {
    const st = tmp();
    const rules = contextResponse("UserPromptSubmit", body(30_000, "R"));
    const core = contextResponse("UserPromptSubmit", body(9000, "C"));
    const lessons = contextResponse("UserPromptSubmit", body(7800, "L"));
    const nativeProven = { isLoaderChild: () => true, ownership: () => ({ owner: false, owners: 2, native: true }) };
    for (let i = 0; i < 6; i++) {
      const merged = [ctxOf(filterClaudeContext(lessons, ups(st, "lessons", `p${i}`, nativeProven))), ctxOf(filterClaudeContext(rules, ups(st, "rules", `p${i}`))), ctxOf(filterClaudeContext(core, ups(st, "core", `p${i}`)))].filter(Boolean).join("\n\n");
      expect(merged.length).toBeLessThanOrEqual(9500);
    }
  });
  test("two loader children of one scope with an identical block for the same prompt: only one speaks", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000, "D"));
    expect(filterClaudeContext(out, ups(st, "core", "p1")).length).toBeGreaterThan(0);
    expect(filterClaudeContext(out, ups(st, "core", "p1"))).toBe("");
  });
});

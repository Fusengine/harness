import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { hasParked } from "../src/runtime/inject-session/units";
import { isLoaderCommand, isLoaderChild } from "../src/runtime/inject-session/loader-child";
import { contextResponse } from "../src/adapters/claude";
import { body, cleanup, ctxOf, inp, tmp } from "./inject-session-helpers";

afterEach(cleanup);
const loader = { isLoaderChild: () => true };

describe("A: hooks-loader double run", () => {
  test("loader copy never claims: unknown units are printed like HEAD, registry untouched", () => {
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(3000));
    expect(filterClaudeContext(out, inp(st, "UserPromptSubmit", loader))).toBe(out);
    expect(existsSync(join(st, "inject-session"))).toBe(false);
  });
  test("loader copy goes silent only for units the native copy already owns", () => {
    const st = tmp();
    const text = body(3000);
    const out = contextResponse("SubagentStart", text);
    const sub = { extra: { agent_id: "a1" } };
    expect(filterClaudeContext(out, inp(st, "SubagentStart", sub))).toBe(out);
    expect(filterClaudeContext(out, inp(st, "SubagentStart", { ...sub, ...loader }))).toBe("");
    const fresh = contextResponse("SubagentStart", `${text}\n\n${body(1500, "NEW")}`);
    const res = ctxOf(filterClaudeContext(fresh, inp(st, "SubagentStart", { ...sub, ...loader })));
    expect(res).toContain("NEW0 ");
    expect(res).not.toContain("u0 ");
  });
  test("loader copy of a parked unit stays silent (native will deliver it) and never drains", () => {
    const st = tmp();
    const out = contextResponse("SubagentStart", body(25_000));
    const sub = { extra: { agent_id: "a1" } };
    filterClaudeContext(out, inp(st, "SubagentStart", sub));
    expect(hasParked(st, "s1.a-a1")).toBe(true);
    expect(ctxOf(filterClaudeContext(out, inp(st, "SubagentStart", { ...sub, ...loader })))).toBe("");
    expect(filterClaudeContext("", inp(st, "PostToolUse", { ...sub, ...loader }))).toBe("");
    expect(hasParked(st, "s1.a-a1")).toBe(true);
  });
  test("a duplicate SessionStart from the loader makes no epoch bump and keeps parked units", () => {
    const st = tmp();
    const out = contextResponse("SessionStart", body(25_000));
    filterClaudeContext(out, inp(st, "SessionStart", { extra: { source: "startup" } }));
    const before = readdirSync(join(st, "inject-session", "s1")).sort();
    filterClaudeContext(out, inp(st, "SessionStart", { extra: { source: "startup" }, ...loader }));
    expect(readdirSync(join(st, "inject-session", "s1")).sort()).toEqual(before);
  });
  test("PreToolUse never drains parked units (a sibling deny would swallow them); PostToolUse does", () => {
    const st = tmp();
    filterClaudeContext(contextResponse("SubagentStart", body(25_000)), inp(st, "SubagentStart", { extra: { agent_id: "a1" } }));
    expect(filterClaudeContext("", inp(st, "PreToolUse", { extra: { agent_id: "a1" } }))).toBe("");
    expect(ctxOf(filterClaudeContext("", inp(st, "PostToolUse", { extra: { agent_id: "a1" } }))).length).toBeGreaterThan(0);
  });
  test("parent detection: loader command recognised; a real child of a loader-named script is detected", () => {
    expect(isLoaderCommand("bun /x/scripts/hooks-loader.ts PreToolUse")).toBe(true);
    expect(isLoaderCommand("claude --foo")).toBe(false);
    const d = tmp();
    const mod = join(import.meta.dir, "../src/runtime/inject-session/loader-child.ts");
    writeFileSync(join(d, "child.ts"), `import { isLoaderChild } from ${JSON.stringify(mod)};\nconsole.log(String(isLoaderChild()));`);
    writeFileSync(join(d, "hooks-loader.ts"), `const r = Bun.spawnSync([process.execPath, ${JSON.stringify(join(d, "child.ts"))}]);\nconsole.log(r.stdout.toString().trim());`);
    const r = Bun.spawnSync([process.execPath, join(d, "hooks-loader.ts")], { env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout.toString().trim()).toBe("true");
    expect(typeof isLoaderChild()).toBe("boolean");
  });
});

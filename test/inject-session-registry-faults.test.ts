import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterClaudeContext } from "../src/runtime/inject-session/filter";
import { deliverNext } from "../src/runtime/inject-session/deliver";
import { openScope } from "../src/runtime/inject-session/registry";
import { hasParked, queued } from "../src/runtime/inject-session/units";
import { contextResponse } from "../src/adapters/claude";
import { body, cleanup, inp, tmp } from "./inject-session-helpers";

afterEach(cleanup);

describe("B: registry failures fail OPEN", () => {
  test("unwritable state dir: full original stdout like HEAD", () => {
    const blocker = join(tmp(), "file");
    writeFileSync(blocker, "x");
    const out = contextResponse("UserPromptSubmit", body(25_000));
    expect(filterClaudeContext(out, inp(join(blocker, "sub"), "UserPromptSubmit"))).toBe(out);
  });
  test("enqueue failure after the scope exists: nothing dropped, full original block printed", () => {
    if (process.getuid?.() === 0) return;
    const st = tmp();
    const out = contextResponse("UserPromptSubmit", body(25_000));
    filterClaudeContext(contextResponse("UserPromptSubmit", "warm"), inp(st, "UserPromptSubmit"));
    const scopeDir = join(st, "inject-session", "s1");
    chmodSync(scopeDir, 0o555);
    try {
      expect(filterClaudeContext(out, inp(st, "UserPromptSubmit"))).toBe(out);
    } finally {
      chmodSync(scopeDir, 0o755);
    }
  });
});

describe("C: unparsable parked file", () => {
  test("is deleted, hasParked clears, and the unit is delivered again", () => {
    const st = tmp();
    const text = body(25_000);
    deliverNext(openScope(st, "s2"), text, 1, "p");
    const root = join(st, "inject-session", "s2");
    const q = readdirSync(root).filter((n) => n.includes(".q."));
    expect(q.length).toBeGreaterThan(0);
    for (const n of q) writeFileSync(join(root, n), "{not json");
    expect(hasParked(st, "s2")).toBe(true);
    expect(queued(openScope(st, "s2")).length).toBe(0);
    expect(hasParked(st, "s2")).toBe(false);
    expect(deliverNext(openScope(st, "s2"), text, 2, "p").length).toBeGreaterThan(0);
  });
  test("parked files are written atomically (no temp leftovers, content parses)", () => {
    const st = tmp();
    deliverNext(openScope(st, "s3"), body(25_000), 1, "p");
    expect(readdirSync(join(st, "inject-session", "s3")).some((n) => n.startsWith(".tmp"))).toBe(false);
    expect(queued(openScope(st, "s3")).length).toBeGreaterThan(0);
  });
});

describe("D: A -> B -> A is redelivered", () => {
  test("a slot that changes and changes back delivers the third state", () => {
    const s = openScope(tmp(), "s4");
    const A = body(500, "A");
    const B = body(500, "B");
    expect(deliverNext(s, A, 1, "core:UserPromptSubmit")).toBe(A);
    expect(deliverNext(s, A, 2, "core:UserPromptSubmit")).toBe("");
    expect(deliverNext(s, B, 3, "core:UserPromptSubmit")).toBe(B);
    expect(deliverNext(s, A, 4, "core:UserPromptSubmit")).toBe(A);
    expect(deliverNext(s, A, 5, "core:UserPromptSubmit")).toBe("");
  });
  test("identical content in another event of the same producer is still delivered once", () => {
    const s = openScope(tmp(), "s5");
    const A = body(500, "R");
    expect(deliverNext(s, A, 1, "rules:SessionStart")).toBe(A);
    expect(deliverNext(s, A, 2, "rules:UserPromptSubmit")).toBe("");
  });
  test("a parked unit whose slot changed is dropped, not delivered stale", () => {
    const s = openScope(tmp(), "s6");
    deliverNext(s, body(25_000, "OLD"), 1, "p");
    const got = [deliverNext(s, body(25_000, "NEW"), 2, "p"), deliverNext(s, "", 3, "p"), deliverNext(s, "", 4, "p"), deliverNext(s, "", 5, "p")].join("\n\n");
    expect(got).toContain("NEW0 ");
    expect(got).not.toContain("OLD20 ");
  });
});

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segment, UNIT_MAX } from "../src/runtime/inject-session/segment";
import { deliverNext } from "../src/runtime/inject-session/deliver";
import { openScope } from "../src/runtime/inject-session/registry";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** Fresh scratch state dir. */
function state(): string {
  const d = mkdtempSync(join(tmpdir(), "inject-session-core-"));
  dirs.push(d);
  return d;
}
/** A multi-paragraph block of roughly `n` chars (each paragraph distinct). */
function block(n: number, tag = "p"): string {
  const paras: string[] = [];
  for (let i = 0; paras.join("\n\n").length < n; i++) paras.push(`${tag}${i} ${"x".repeat(300)}\nline two of ${tag}${i}`);
  return paras.join("\n\n");
}

describe("segment", () => {
  test("every unit is < 9500 chars and units rejoin to the original", () => {
    const text = block(31_000);
    const units = segment(text);
    expect(units.length).toBeGreaterThan(3);
    for (const u of units) expect(u.length).toBeLessThanOrEqual(UNIT_MAX);
    expect(units.join("\n\n")).toBe(text);
  });
  test("an oversized paragraph is cut on line breaks, order preserved", () => {
    const para = Array.from({ length: 400 }, (_, i) => `line-${i} ${"y".repeat(50)}`).join("\n");
    const units = segment(para);
    expect(units.every((u) => u.length <= UNIT_MAX)).toBe(true);
    expect(units.join("\n")).toBe(para);
  });
  test("a single over-long line is hard-sliced, nothing lost", () => {
    const units = segment("z".repeat(25_000));
    expect(units.join("")).toBe("z".repeat(25_000));
    expect(units.every((u) => u.length <= UNIT_MAX)).toBe(true);
  });
  test("blank input yields no unit; segmentation is deterministic", () => {
    expect(segment("  \n\n ")).toEqual([]);
    const t = block(5000);
    expect(segment(t)).toEqual(segment(t));
  });
});

describe("deliverNext: once per scope, chunked first delivery", () => {
  test("same block twice: second call delivers nothing", () => {
    const s = openScope(state(), "sid1");
    const text = block(4000);
    expect(deliverNext(s, text, 1000)).toBe(text);
    expect(deliverNext(s, text, 2000)).toBe("");
  });
  test("a changed unit is re-delivered, unchanged ones are not", () => {
    const s = openScope(state(), "sid2");
    const a = block(3000, "a");
    const b = block(3000, "b");
    deliverNext(s, `${a}\n\n${b}`, 1000);
    const out = deliverNext(s, `${a}\n\n${b.replace("b0 ", "B0 ")}`, 2000);
    expect(out).toContain("B0 ");
    expect(out.length).toBeLessThan(`${a}\n\n${b}`.length);
  });
  test("a 31 KB block is delivered over successive calls, each < 9500, full content once, in order", () => {
    const s = openScope(state(), "sid3");
    const text = block(31_000);
    const got: string[] = [];
    for (let i = 0; i < 8; i++) {
      const piece = deliverNext(s, text, 1000 + i);
      expect(piece.length).toBeLessThan(9500);
      if (piece) got.push(piece);
    }
    expect(got.length).toBeGreaterThanOrEqual(4);
    expect(got.join("\n\n")).toBe(text);
  });
  test("parked units drain with empty input (tool-event path) and keep order", () => {
    const s = openScope(state(), "sid4");
    const text = block(25_000);
    const first = deliverNext(s, text, 1000);
    const rest = [deliverNext(s, "", 1001), deliverNext(s, "", 1002), deliverNext(s, "", 1003)].join("\n\n");
    expect(`${first}\n\n${rest}`.replace(/\n\n$/, "").replace(/\n\n+/g, "\n\n")).toBe(text);
    expect(deliverNext(s, "", 1004)).toBe("");
  });
  test("SessionStart reset: sibling plugin scopes of one event share the epoch; a repeated SessionStart or another source starts a new one", () => {
    const dir = state();
    const text = block(3000);
    const s1 = openScope(dir, "sid5", { source: "startup", scope: "rules" });
    expect(deliverNext(s1, text, 1000)).toBe(text);
    const sibling = openScope(dir, "sid5", { source: "startup", scope: "lessons" });
    expect(sibling.epoch).toBe(s1.epoch);
    expect(deliverNext(sibling, text, 1500)).toBe("");
    const repeated = openScope(dir, "sid5", { source: "startup", scope: "rules" });
    expect(repeated.epoch).toBe(s1.epoch + 1);
    expect(deliverNext(repeated, text, 2000)).toBe(text);
    const afterCompact = openScope(dir, "sid5", { source: "compact", scope: "lessons" });
    expect(afterCompact.epoch).toBe(repeated.epoch + 1);
    expect(deliverNext(afterCompact, text, 3000)).toBe(text);
    expect(openScope(dir, "sid5", { source: "compact", scope: "rules" }).epoch).toBe(afterCompact.epoch);
    const resumed = openScope(dir, "sid5", { source: "resume", scope: "rules" });
    expect(resumed.epoch).toBe(afterCompact.epoch);
    expect(deliverNext(resumed, text, 4000)).toBe("");
    expect(openScope(dir, "sid5", { source: "fork", scope: "rules" }).epoch).toBe(afterCompact.epoch + 1);
  });
  test("a different scope (sub-agent) gets the full set once, independent of the parent", () => {
    const dir = state();
    const text = block(3000);
    deliverNext(openScope(dir, "sid6"), text, 1000);
    const sub = openScope(dir, "sid6.a-agent1");
    expect(deliverNext(sub, text, 1000)).toBe(text);
    expect(deliverNext(sub, text, 1001)).toBe("");
  });
  test("concurrent siblings: each unit goes to exactly one caller", () => {
    const dir = state();
    const text = block(6000);
    const a = deliverNext(openScope(dir, "sid7"), text, 1000);
    const b = deliverNext(openScope(dir, "sid7"), text, 1000);
    expect(a).toBe(text);
    expect(b).toBe("");
  });
});

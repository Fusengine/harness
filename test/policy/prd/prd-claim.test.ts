import { describe, expect, test } from "bun:test";
import { resolveClaim } from "../../../src/policy/prd/prd-claim";
import { evaluateWriteOwnership } from "../../../src/policy/prd/prd-ownership";
import { isSlotClosed } from "../../../src/policy/prd/prd-crosscheck";
import type { PrdAgentReportFile, PrdIdentity, PrdTaskFile } from "../../../src/policy/prd/interfaces/types";

const SLOTS = ["t", "t-2", "t-3", "t-4"];
const claim = (target: string, agentId: string, bindings: Record<string, string> = {}, closed = false) =>
  resolveClaim({ target, agentType: "t", agentId, candidates: SLOTS, bindings, closed });
const reasonOf = (v: { allow: boolean | "advisory"; reason?: string }): string => v.reason ?? "";

describe("resolveClaim", () => {
  test("claim-nth-before-exact: a -n slot is claimable on a cold start, exact slot still free", () => {
    expect(claim("t-3", "a1")).toEqual({ allow: true, bind: { agentId: "a1", name: "t-3" } });
  });

  test("claim-any-order-4-agents-5th-denied: 4 agents take 4 slots in any order, a 5th is refused everywhere", () => {
    let bindings: Record<string, string> = {};
    for (const [id, slot] of [["a1", "t-4"], ["a2", "t"], ["a3", "t-3"], ["a4", "t-2"]] as const) {
      const v = claim(slot, id, bindings);
      expect(v).toEqual({ allow: true, bind: { agentId: id, name: slot } });
      bindings = { ...bindings, [id]: slot };
    }
    for (const slot of [...SLOTS, "t-5"]) expect(claim(slot, "a5", bindings).allow).toBe(false);
  });

  test("claim-one-slot-per-agent: an agent that owns a slot cannot write another, may rewrite its own", () => {
    const bindings = { a1: "t-2" };
    expect(claim("t-3", "a1", bindings).allow).toBe(false);
    expect(reasonOf(claim("t-3", "a1", bindings) as never)).toContain("one slot per agent");
    expect(claim("t-2", "a1", bindings)).toEqual({ allow: true });
  });

  test("claim-live-bound-slot-denied-to-other-id: separate message from 'already own a slot'", () => {
    const v = claim("t-2", "a2", { a1: "t-2" });
    expect(v.allow).toBe(false);
    expect(reasonOf(v as never)).toContain("already owned by another agent");
  });

  test("claim-closed-slot-denied-fresh-session: complete on disk + empty bindings -> deny, distinct message", () => {
    const v = claim("t-2", "a9", {}, true);
    expect(v.allow).toBe(false);
    expect(reasonOf(v as never)).toContain("already reported complete");
  });

  test("claim-closed-slot-owner-may-rewrite: the current-session owner is not blocked by closed", () => {
    expect(claim("t-2", "a1", { a1: "t-2" }, true)).toEqual({ allow: true });
  });

  test("claim-type-mismatch-denied: slot of another type / unknown name", () => {
    const v = resolveClaim({ target: "other-expert", agentType: "t", agentId: "a1", candidates: SLOTS, bindings: {}, closed: false });
    expect(v.allow).toBe(false);
    expect(reasonOf(v as never)).toContain("not a slot of your agent_type");
  });

  test("rule order: out-of-type beats everything, owner check beats closed", () => {
    expect(claim("zzz", "a1", { a1: "zzz" }, true).allow).toBe(false);
    expect(claim("t-2", "a1", { a1: "t-3" }, true).allow).toBe(false);
  });
});

describe("evaluateWriteOwnership (claim through the public verdict)", () => {
  const taskFile: PrdTaskFile = Object.fromEntries(SLOTS.map((s) => [s, { files: [], "sub-tasks": { x: { status: "assigned" as const } } }]));
  const sub = (agentId: string, agentType: string | undefined = "t"): PrdIdentity => ({ lead: false, agentId, ...(agentType ? { agentType } : {}) });
  const input = (identity: PrdIdentity, agent = "t-2", closed?: boolean) =>
    ({ kind: { kind: "agentReport" as const, agent }, identity, taskFile, bindings: {}, ...(closed === undefined ? {} : { closed }) });

  test("claim-lead-and-unknown-unchanged", () => {
    expect(evaluateWriteOwnership(input({ lead: true })).allow).toBe(false);
    expect(evaluateWriteOwnership(input({ lead: "unknown" }))).toEqual({ allow: "advisory" });
    expect(evaluateWriteOwnership(input({ lead: "unknown", agentId: "a", agentType: "t" }, "t-2", true))).toEqual({ allow: "advisory" });
  });

  test("claim-agent-id-without-type-denied (fail-closed)", () => {
    expect(evaluateWriteOwnership(input({ lead: false, agentId: "a1" })).allow).toBe(false);
  });

  test("closed flag reaches the claim rule", () => {
    expect(evaluateWriteOwnership(input(sub("a1"), "t-2", true)).allow).toBe(false);
    expect(evaluateWriteOwnership(input(sub("a1"), "t-2", false)).allow).toBe(true);
  });
});

describe("isSlotClosed", () => {
  const entry = (...subs: [string, "assigned" | "validated"][]) => ({ files: [], "sub-tasks": Object.fromEntries(subs.map(([k, status]) => [k, { status }])) });
  const doneReport = (task: string, ...subs: string[]): PrdAgentReportFile =>
    ({ [task]: Object.fromEntries(subs.map((s) => [s, { status: "done" as const, modified: [], unchanged: [] }])) });

  test("complete report -> closed; partial report (dead agent) -> open (claim-partial-report-of-dead-agent-claimable)", () => {
    const files = { A: { s: entry(["one", "assigned"], ["two", "assigned"]) } };
    expect(isSlotClosed("s", files, doneReport("A", "one", "two"))).toBe(true);
    expect(isSlotClosed("s", files, doneReport("A", "one"))).toBe(false);
    expect(isSlotClosed("s", files, null)).toBe(false);
  });

  test("claim-compacted-slot-never-claimable: compacted entry is closed without any report", () => {
    const files: Record<string, PrdTaskFile> = { A: { s: { status: "validated", files: [], "validated-at": "t" } } };
    expect(isSlotClosed("s", files, null)).toBe(true);
  });

  test("validated sub-tasks count as closed; undeclared slot and empty sub-tasks are not closed", () => {
    expect(isSlotClosed("s", { A: { s: entry(["one", "validated"]) } }, null)).toBe(true);
    expect(isSlotClosed("ghost", { A: { s: entry(["one", "validated"]) } }, null)).toBe(false);
    expect(isSlotClosed("s", { A: { s: entry() } }, null)).toBe(false);
    expect(isSlotClosed("s", { A: null }, null)).toBe(false);
  });

  test("a slot reused across tasks is closed only when EVERY task's sub-tasks are done", () => {
    const files = { A: { s: entry(["one", "assigned"]) }, B: { s: entry(["two", "assigned"]) } };
    expect(isSlotClosed("s", files, { ...doneReport("A", "one") })).toBe(false);
    expect(isSlotClosed("s", files, { ...doneReport("A", "one"), ...doneReport("B", "two") })).toBe(true);
  });

  test("prototype-named slot never throws nor reads inherited keys", () => {
    expect(isSlotClosed("constructor", { A: { s: entry(["one", "validated"]) } }, null)).toBe(false);
  });
});

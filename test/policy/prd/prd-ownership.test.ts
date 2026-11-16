import { describe, expect, test } from "bun:test";
import {
  candidateAgentNames, evaluateWriteOwnership, matchesAgentName,
} from "../../../src/policy/prd/prd-ownership";
import { resolveClaim } from "../../../src/policy/prd/prd-claim";
import type { PrdIdentity, PrdTaskFile } from "../../../src/policy/prd/interfaces/types";

describe("matchesAgentName", () => {
  test("exact match", () => {
    expect(matchesAgentName("backend-expert", "backend-expert")).toBe(true);
  });
  test("suffixed with n >= 2", () => {
    expect(matchesAgentName("backend-expert-2", "backend-expert")).toBe(true);
  });
  test("rejects -1 suffix", () => {
    expect(matchesAgentName("backend-expert-1", "backend-expert")).toBe(false);
  });
  test("rejects non-numeric suffix", () => {
    expect(matchesAgentName("backend-expert-x", "backend-expert")).toBe(false);
  });
  test("rejects a name that merely starts with the type", () => {
    expect(matchesAgentName("backend-expertise", "backend-expert")).toBe(false);
  });
});

describe("candidateAgentNames", () => {
  const taskFile: PrdTaskFile = {
    "backend-expert": { files: [], "sub-tasks": {} },
    "backend-expert-2": { files: [], "sub-tasks": {} },
    "frontend-expert": { files: [], "sub-tasks": {} },
  };
  test("filters task-file agents by name match", () => {
    expect(candidateAgentNames("backend-expert", taskFile).sort()).toEqual(["backend-expert", "backend-expert-2"]);
  });
  test("empty when nothing matches", () => {
    expect(candidateAgentNames("ghost-expert", taskFile)).toEqual([]);
  });
});

describe("resolveClaim (replaces resolveOwnerBinding; full matrix in prd-claim.test.ts)", () => {
  const base = { agentType: "x", candidates: ["a", "b"], closed: false };
  test("already bound to the same slot -> allow, no new bind", () => {
    expect(resolveClaim({ ...base, target: "a", agentId: "id-1", bindings: { "id-1": "a" } })).toEqual({ allow: true });
  });
  test("two free candidates -> either may be claimed (no ambiguity)", () => {
    expect(resolveClaim({ ...base, target: "b", agentId: "id-1", bindings: {} })).toEqual({ allow: true, bind: { agentId: "id-1", name: "b" } });
  });
  test("slot bound to a different id -> denied", () => {
    expect(resolveClaim({ ...base, target: "a", agentId: "id-2", bindings: { "id-1": "a" } }).allow).toBe(false);
  });
  test("zero candidates -> denied", () => {
    expect(resolveClaim({ ...base, candidates: [], target: "a", agentId: "id-1", bindings: {} }).allow).toBe(false);
  });
});

describe("evaluateWriteOwnership", () => {
  const taskFile: PrdTaskFile = {
    "backend-expert": { files: ["a.ts"], "sub-tasks": { jwt: { status: "assigned" } } },
    "backend-expert-2": { files: ["b.ts"], "sub-tasks": { session: { status: "assigned" } } },
  };
  const lead: PrdIdentity = { lead: true };
  const sub = (agentType: string, agentId = "id-1"): PrdIdentity => ({ lead: false, agentType, agentId });
  const unknown: PrdIdentity = { lead: "unknown" };

  for (const kind of [{ kind: "router" as const }, { kind: "task" as const, task: "t" }, { kind: "docs" as const, task: "t" }]) {
    test(`${kind.kind}: lead allowed, sub denied, unknown advisory`, () => {
      expect(evaluateWriteOwnership({ kind, identity: lead, taskFile: null, bindings: {} })).toEqual({ allow: true });
      const subVerdict = evaluateWriteOwnership({ kind, identity: sub("backend-expert"), taskFile: null, bindings: {} });
      expect(subVerdict.allow).toBe(false);
      expect(evaluateWriteOwnership({ kind, identity: unknown, taskFile: null, bindings: {} })).toEqual({ allow: "advisory" });
    });
  }

  test("agentReport: lead denied", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert" }, identity: lead, taskFile, bindings: {},
    });
    expect(verdict.allow).toBe(false);
  });
  test("agentReport: sub allowed when its own name is the sole free candidate", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert" },
      identity: sub("backend-expert"), taskFile, bindings: { "id-9": "backend-expert-2" },
    });
    expect(verdict).toEqual({ allow: true, bind: { agentId: "id-1", name: "backend-expert" } });
  });
  test("agentReport: sub denied when target is not a slot of its agent_type", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert-2" },
      identity: sub("frontend-expert"), taskFile, bindings: {},
    });
    expect(verdict.allow).toBe(false);
  });
  test("agentReport: a -n slot may be claimed before the exact name (order-independent)", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert-2" },
      identity: sub("backend-expert"), taskFile, bindings: {},
    });
    expect(verdict).toEqual({ allow: true, bind: { agentId: "id-1", name: "backend-expert-2" } });
  });
  test("agentReport: sub denied when already bound to a different agentId", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert" },
      identity: sub("backend-expert", "id-2"), taskFile, bindings: { "id-1": "backend-expert" },
    });
    expect(verdict.allow).toBe(false);
  });
  test("agentReport: agent_id present without agent_type -> deny (fail-closed)", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert" },
      identity: { lead: false, agentId: "id-1" }, taskFile, bindings: {},
    });
    expect(verdict.allow).toBe(false);
  });
  test("agentReport: unknown lead is always advisory", () => {
    const verdict = evaluateWriteOwnership({
      kind: { kind: "agentReport", agent: "backend-expert" }, identity: unknown, taskFile, bindings: {},
    });
    expect(verdict).toEqual({ allow: "advisory" });
  });

  test("other: denied for lead and sub, advisory for unknown", () => {
    expect(evaluateWriteOwnership({ kind: { kind: "other" }, identity: lead, taskFile: null, bindings: {} }).allow).toBe(false);
    expect(evaluateWriteOwnership({ kind: { kind: "other" }, identity: sub("backend-expert"), taskFile: null, bindings: {} }).allow).toBe(false);
    expect(evaluateWriteOwnership({ kind: { kind: "other" }, identity: unknown, taskFile: null, bindings: {} })).toEqual({ allow: "advisory" });
  });
});

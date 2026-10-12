/**
 * @module test/apex-deny-helpers
 * State matrix for the "deny lists every missing prerequisite" tests: five
 * independent APEX prerequisites (brainstorm, explore+research, Check 1 doc,
 * Check 2 docs, SOLID refs) → 2^5 sessions, each with its own isolated track file.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTrack, recordAgent, recordBrainstormRequired, recordDoc, recordRefRead } from "../src/tracking/session-state";
import { loadTrack, saveTrack } from "../src/tracking/store";
import type { GateInput } from "../src/runtime/gate-input";
import type { RefMeta } from "../src/refs/types";
import type { SessionTrack } from "../src/tracking/session-state";

export const NOW = 1_800_000_000_000;
export const WINDOW = 900_000;
export const GATE_NAMES = ["brainstorm", "fresh", "check1", "doc", "solid"] as const;
export type GateName = (typeof GATE_NAMES)[number];
/** Which prerequisites are MISSING in a state. */
export type Missing = Record<GateName, boolean>;

const root = mkdtempSync(join(tmpdir(), "fh-deny-all-"));
let seq = 0;

/** Remove the module's temp dir (call from the test file's `afterAll`). */
export function cleanupDeny(): void {
  rmSync(root, { recursive: true, force: true });
}

/** Titles the five gates return (framework "react"). */
export const TITLES: Record<GateName, string> = {
  brainstorm: "APEX: brainstorm first",
  fresh: "APEX: explore + research required",
  check1: "APEX: react documentation required",
  doc: "APEX: documentation not consulted",
  solid: "APEX: read SOLID references for react",
};

/** Routed SOLID refs (no framework name in the path, so reading them never satisfies Check 1's skill-read shortcut). */
export const REFS: RefMeta[] = ["srp", "dry"].map((name) => ({ name, description: "", keywords: "", priority: "", related: "", appliesTo: "**/*.ts", triggerOnEdit: "", level: "principle", filePath: `/skills/solid-generic/references/${name}.md` }));

/** The 2^5 missing-combinations, in a stable order. */
export function allMissing(): Missing[] {
  return Array.from({ length: 32 }, (_, i) => Object.fromEntries(GATE_NAMES.map((g, j) => [g, !!(i & (1 << j))])) as Missing);
}

/** Track holding exactly the evidence for the prerequisites NOT missing. */
export function trackFor(m: Missing): SessionTrack {
  let t = recordBrainstormRequired(emptyTrack(), m.brainstorm);
  if (!m.brainstorm) t = recordAgent(t, "brainstorming", NOW - 1000, "sufficient");
  if (!m.fresh) for (const a of ["explore-codebase", "research-expert"]) t = recordAgent(t, a, NOW - 1000, "sufficient");
  // Check 1 = a react stamp; Check 2 = BOTH sources in the session (any framework).
  if (!m.check1) t = recordDoc(t, "react", "s1", "context7", NOW - 1000);
  if (!m.doc) for (const src of ["context7", "exa"]) t = recordDoc(t, m.check1 ? "php" : "react", "s1", src, NOW - 1000);
  if (!m.solid) for (const r of REFS) t = recordRefRead(t, r.filePath, NOW - 1000);
  return t;
}

/** A Write input for state `m` with a fresh isolated track file; fields are overridable (throwing `loadRefs` probes, tool, path). */
export async function inputFor(m: Missing, over: Partial<GateInput> = {}): Promise<GateInput> {
  const dir = join(root, `s${++seq}`);
  mkdirSync(dir, { recursive: true });
  const trackFile = join(dir, "track-s1.json");
  await saveTrack(trackFile, trackFor(m));
  const content = Array.from({ length: 8 }, (_, i) => `export const v${i} = ${i};`).join("\n");
  return { sessionId: "s1", framework: "react", tool: "Write", filePath: join(dir, "src", "calc.ts"), content, cwd: dir, now: NOW, windowMs: WINDOW, trackFile, loadRefs: async () => REFS, ...over };
}

/** Whether the run persisted a Check-1 `target` into the state's track. */
export async function targetSet(input: GateInput): Promise<boolean> {
  return !!(await loadTrack(input.trackFile)).target;
}

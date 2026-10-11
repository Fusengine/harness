import { test, expect } from "bun:test";
import { initDesignState, type DesignState } from "../src/policy/design/state";
import { designSystemWriteGate } from "../src/policy/design/gates-pipeline";

/**
 * Defect 3: the design-system.md write refusal said "Screenshot real sector
 * sites" (any fuse-browser capture counts, not just single shots) and never
 * said WHAT was missing. The refusal must now list exactly the unmet
 * requirements: corpus reads credited at the credited root (with its path)
 * and screenshots taken/required (N/M). Blocking conditions and thresholds
 * are unchanged — only the text moves.
 */
const ROOT = "/plugins/design-expert/skills/refs-design";
const st = (over: Partial<DesignState>): DesignState => ({ ...initDesignState("ag", "full", false), ...over });

test("refusal with 0 screenshots shows 0/M and the credited corpus root path", () => {
  const v = designSystemWriteGate("design-system.md", st({ currentPhase: 1 }), true, ROOT);
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("0/2"); // full mode + corpus delivered => quota 2
  expect(v?.reason).toContain(ROOT);
});

test("screenshots sufficient but corpus missing -> ONLY the corpus gap is listed", () => {
  const v = designSystemWriteGate("design-system.md", st({ currentPhase: 1, screenshotsCount: 2 }), true, ROOT);
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("corpus reads");
  expect(v?.reason).toContain(ROOT);
  expect(v?.reason).not.toContain("screenshots:");
});

test("corpus absent (requirement waived) -> no corpus line, full-mode quota is 4", () => {
  const v = designSystemWriteGate("design-system.md", st({ currentPhase: 1 }), false);
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("0/4");
  expect(v?.reason).not.toContain("corpus reads");
});

test("any fuse-browser capture counts — the refusal no longer mandates a single-tool screenshot", () => {
  const v = designSystemWriteGate("design-system.md", st({ currentPhase: 1 }), true, ROOT);
  expect(v?.reason).not.toContain("Screenshot real sector sites");
  expect(v?.reason).toContain("browser_shots_batch");
});

test("thresholds unchanged: quota met at phase 2 passes, unmet screenshot quota still blocks with N/M", () => {
  expect(designSystemWriteGate("design-system.md", st({ currentPhase: 2, screenshotsCount: 2 }), true, ROOT)).toBeNull();
  const v = designSystemWriteGate("design-system.md", st({ currentPhase: 2, mode: "page", screenshotsCount: 0 }), true, ROOT);
  expect(v?.kind).toBe("block");
  expect(v?.reason).toContain("0/1");
});

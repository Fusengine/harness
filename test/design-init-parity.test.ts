import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designGate } from "../src/runtime/design";
import { setActiveDesignAgent } from "../src/policy/design/flag";
import { loadDesignState } from "../src/policy/design/state";
import type { NormalizedEvent } from "../src/runtime/normalize";

/**
 * Init parity with dd8a2e1 (passe 3, défaut 2): the design state initializes
 * from `findDesignSystem(cwd)` — the cwd walk ONLY — never from the FIRST
 * event's filePath. A `sub/design-system.md` seen through a first Read/Grep/
 * Write must NOT flip the session into `page` mode (screenshot quota 2
 * instead of 4 without corpus, phase computed accordingly). The per-file
 * resolver (passe 2) stays in charge at the WRITE gate only.
 */

const VALID_DS = "## Design Reference\n- Source: https://example.com\n--a: oklch(0.62 0.19 250);";
const SHOT = "mcp__fuse-browser__browser_screenshot";

function setup() {
  const cache = mkdtempSync(join(tmpdir(), "fh-di-"));
  const proj = mkdtempSync(join(tmpdir(), "fh-di-p-"));
  const plugins = mkdtempSync(join(tmpdir(), "fh-di-g-"));
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(join(proj, "sub", "design-system.md"), VALID_DS);
  setActiveDesignAgent(cache, "ag");
  const gate = (e: NormalizedEvent) => designGate({ agent_id: "ag" }, e, cache, proj, "", plugins);
  return { cache, proj, gate };
}

const pre = (tool: string, filePath?: string, content = ""): NormalizedEvent =>
  ({ phase: "pre", tool, input: {}, sessionId: "s", filePath, content });
const post = (tool: string, filePath?: string): NormalizedEvent =>
  ({ phase: "post", tool, input: {}, sessionId: "s", filePath });

/** First-event shapes that must ALL initialize the state identically (dd8a2e1). */
const FIRST_EVENTS: Array<[string, (proj: string) => NormalizedEvent]> = [
  ["pre Read sub/notes.md", (p) => pre("Read", join(p, "sub", "notes.md"))],
  ["pre Grep sub/notes.md", (p) => pre("Grep", join(p, "sub", "notes.md"))],
  ["pre Write sub/a.html", (p) => pre("Write", join(p, "sub", "a.html"), "<html><body>x</body></html>")],
  ["pre Edit sub/notes.md", (p) => pre("Edit", join(p, "sub", "notes.md"), "x")],
  ["pre apply_patch sub/a.html", (p) => ({ phase: "pre", tool: "apply_patch", input: {}, sessionId: "s", files: [{ filePath: join(p, "sub", "a.html"), content: "<html></html>", op: "add" }] })],
  ["post Read sub/notes.md", (p) => post("Read", join(p, "sub", "notes.md"))],
  ["pre Grep (no filePath)", () => pre("Grep")],
];

test("init parity: the first event's filePath NEVER decides the session mode (dd8a2e1)", () => {
  for (const [name, build] of FIRST_EVENTS) {
    const { cache, proj, gate } = setup();
    gate(build(proj));
    const s = loadDesignState(cache, "ag");
    expect(s, name).not.toBeNull();
    expect(s!.mode, name).toBe("full");
    expect(s!.designSystemExists, name).toBe(false);
    // 2 post captures: full mode without corpus needs 4 — phase stays 0.
    gate(post(SHOT));
    gate(post(SHOT));
    expect(loadDesignState(cache, "ag")!.currentPhase, name).toBe(0);
    // The counter-example's final write MUST stay blocked (2/4 screenshots).
    const p = gate(pre("Write", join(proj, "design-system.md"), VALID_DS));
    expect(p?.kind, name).toBe("block");
    expect(p?.reason, name).toContain("2/4");
  }
});

test("owner case still passes: Write <dir>/index.html with <dir>/design-system.md present, cwd a parent", () => {
  const { cache, proj, gate } = setup();
  // State initialized as in dd8a2e1 (no design-system.md at cwd → mode full).
  gate(pre("Read", join(proj, "sub", "notes.md")));
  expect(loadDesignState(cache, "ag")!.mode).toBe("full");
  // Full pipeline, no corpus: 4 screenshots reach phase 2.
  for (let i = 0; i < 4; i++) gate(post(SHOT));
  expect(loadDesignState(cache, "ag")!.currentPhase).toBe(2);
  // A valid design-system.md write in sub/ passes PRE, and POST validates the real file → phase 3.
  expect(gate(pre("Write", join(proj, "sub", "design-system.md"), VALID_DS))).toBeNull();
  gate(post("Write", join(proj, "sub", "design-system.md")));
  const s = loadDesignState(cache, "ag")!;
  expect(s.currentPhase).toBe(3);
  expect(s.designSystemValid).toBe(true);
  // The owner case passes via the per-file resolver (passe 2) — NOT a mode change.
  expect(gate(pre("Write", join(proj, "sub", "index.html"), "<html></html>"))).toBeNull();
});

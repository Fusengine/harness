/**
 * Sim replay under fan-out: every test/sim scenario step is spawned with the
 * scopes its host would really spawn (concurrent, rendezvous ON) and compared
 * to the same scopes run separately (OFF) in the leader's order: stdout,
 * stderr, exit and final on-disk state must be identical.
 *
 * Default: a representative subset. `RDV_FULL=1 bun test test/multi-rdv-sim.test.ts` replays all.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runCase } from "./multi-differential";
import { scenarioToCase } from "./multi-sim";
import { BURST_DEDUP_MS } from "../src/runtime/burst-window";
import type { Case } from "./multi-differential";
import type { Sandbox } from "./multi-spawn";

const DIR = join(import.meta.dir, "sim", "scenarios");
const ALL = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const SUBSET = ["01-", "03-", "13-", "16-", "19-", "22-", "17-", "07-"];
const PICK = process.env.RDV_FULL === "1" ? ALL : ALL.filter((f) => SUBSET.some((p) => f.startsWith(p)));

/**
 * Make the deny-loop `[REPEAT]` decision deterministic in both passes. The sidecar folds an identical deny
 * landing within BURST_DEDUP_MS of the previous one into the SAME event (no REPEAT); beyond it, it is a real
 * retry (REPEAT #2). The B pass (concurrent) and the A pass (sequential) take different wall time, so under
 * load the gap between two identical events crossed the window in one pass only. A delay before a re-sent
 * identical event (applied to A and B alike) pins the gap above the window: both passes see a real retry.
 */
function pinRepeatWindow(c: Case): Case {
  const probe = { cwd: "/probe", home: "/probe" } as Sandbox;
  const seen = new Set<string>();
  const steps = c.steps.map((step) => {
    const key = JSON.stringify(step.payloadFor(probe));
    const again = seen.has(key);
    seen.add(key);
    return again ? { ...step, delayMs: Math.max(step.delayMs ?? 0, BURST_DEDUP_MS + 500) } : step;
  });
  return { ...c, steps };
}

describe("sim scenarios under rendezvous fan-out", () => {
  for (const file of PICK) {
    test(file, async () => {
      const { steps, stateDiffs } = await runCase(pinRepeatWindow(scenarioToCase(join(DIR, file))));
      for (const s of steps) {
        expect(s.outputDiffs).toEqual([]);
        // the rendezvous really ran: the leader executed several of the scopes (slow ones are handed back, see stats.ts)
        expect(s.order.length).toBeGreaterThanOrEqual(Math.min(2, s.scopes.length));
      }
      expect(stateDiffs).toEqual([]);
    }, 300_000);
  }
});

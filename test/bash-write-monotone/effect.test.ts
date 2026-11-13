/**
 * EFFECT oracle suite (slow, opt-in: `FUSE_SLOW_TESTS=1 bun test test/bash-write-monotone/effect.test.ts`).
 * Every composed command really runs under bash in a throwaway temp dir; the verdict of the real
 * hook path is compared with whether `src/x.ts` changed. `MONO_STRIDE=k` samples depth 2 / neutral.
 */
import { describe, expect, test } from "bun:test";
import { measure, standardCases, stride, tally } from "../helpers/monotone-measure";

const slow = process.env.FUSE_SLOW_TESTS === "1";
const k = Number(process.env.MONO_STRIDE ?? "5");

describe.skipIf(!slow)("effect oracle vs hook verdict", () => {
  test("atoms really write at depth 0 and neutral forms really do not", async () => {
    const { exec0, neutral } = standardCases(k);
    const rows = await measure([...exec0, ...stride(neutral, 3)]);
    expect(rows.filter((r) => r.kind === "exec" && !r.effect).map((r) => r.label)).toEqual([]);
    expect(rows.filter((r) => r.kind === "neutral" && r.effect).map((r) => r.label)).toEqual([]);
  }, 600_000);

  test("no executing deny-atom context is allowed or asked (bypass = 0)", async () => {
    const { exec1, exec2 } = standardCases(k);
    const rows = await measure([...exec1, ...exec2]);
    const t = tally(rows);
    const bad = rows.filter((r) => r.effect && r.verdict !== "block").map((r) => `${r.verdict}:${r.label}`);
    console.log("bypass tally", JSON.stringify(t));
    expect(bad.slice(0, 25)).toEqual([]);
  }, 600_000);
});

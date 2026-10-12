/**
 * An APEX deny lists the other missing prerequisites alongside the deciding one. The deciding
 * gate (first failing one) keeps its kind/title/reason; the others are appended. A PRE-gate
 * deny (brainstorm, explore+research) never loads the refs, so it lists only the ref-free
 * gates (brainstorm, freshness, Check 2 docs); Check 1 and SOLID refs are listed once the
 * deciding gate is past the refs load. 2^5 states.
 */
import { afterAll, expect, test } from "bun:test";
import { apexScopedGate } from "../src/runtime/gate-apex";
import { allMissing, cleanupDeny, GATE_NAMES, inputFor, REFS, targetSet, TITLES, WINDOW, type GateName, type Missing } from "./apex-deny-helpers";
import { loadTrack } from "../src/tracking/store";

afterAll(cleanupDeny);

const failing = (m: Missing) => GATE_NAMES.filter((g) => m[g]);
const NEEDS_REFS: ReadonlySet<GateName> = new Set(["check1", "solid"]);
/** Gates the deny must list besides its decider: later failing ones; refs-dependent ones only when the decider is past the refs load. */
const isPre = (g: GateName | undefined): boolean => g === "brainstorm" || g === "fresh";
const expectedOthers = (f: GateName[]): GateName[] => f.slice(1).filter((g) => !(isPre(f[0]) && NEEDS_REFS.has(g)));
const run = async (m: Missing, over = {}) => {
  const input = await inputFor(m, over);
  return { input, out: await apexScopedGate(input, await loadTrack(input.trackFile), WINDOW) };
};

test("one deny lists the other missing prerequisites (all 32 states, refs never loaded for a PRE deny)", async () => {
  const bad: string[] = [];
  for (const m of allMissing()) {
    const f = failing(m);
    let loads = 0;
    const { input, out } = await run(m, { loadRefs: async () => { loads++; return REFS; } });
    if (f.length === 0) { if (out !== null) bad.push(`allow expected for ${JSON.stringify(m)}`); continue; }
    if (!out) { bad.push(`block expected for ${f}`); continue; }
    if (out.kind !== "block" || out.title !== TITLES[f[0]!]) bad.push(`decider ${f} -> ${out.title}`);
    const want = expectedOthers(f);
    for (const g of GATE_NAMES.filter((x) => x !== f[0])) if (out.reason.includes(TITLES[g]) !== want.includes(g)) bad.push(`${f}: ${g} listed=${out.reason.includes(TITLES[g])} want=${want.includes(g)}`);
    if (new Set(out.actions).size !== out.actions?.length) bad.push(`${f}: duplicate actions`);
    if (out.reason.includes("same pass")) bad.push(`${f}: wording promises a single pass`);
    if (isPre(f[0]) && loads !== 0) bad.push(`${f}: PRE deny loaded the refs`);
    if ((await targetSet(input)) !== (f[0] === "check1")) bad.push(`${f}: recordTarget side effect wrong`);
  }
  expect(bad).toEqual([]);
});

test("a PRE deny lists only the ref-free gates; a Check 1 deny lists Check 2 and SOLID, actions merged first-gate-first and deduplicated", async () => {
  const pre = (await run({ brainstorm: true, fresh: true, check1: true, doc: true, solid: true })).out;
  expect(pre?.title).toBe(TITLES.brainstorm);
  expect(pre?.reason).toContain(TITLES.fresh);
  expect(pre?.reason).toContain(TITLES.doc);
  expect(pre?.reason).not.toContain(TITLES.check1);
  expect(pre?.reason).not.toContain(TITLES.solid);
  expect(pre?.actions?.[0]).toBe("Launch the brainstorming agent");
  const post = (await run({ brainstorm: false, fresh: false, check1: true, doc: true, solid: true })).out;
  expect(post?.title).toBe(TITLES.check1);
  expect(post?.reason).toContain(TITLES.doc);
  expect(post?.reason).toContain(TITLES.solid);
  const refs = REFS.map((r) => r.filePath);
  expect(post?.actions?.filter((a) => refs.includes(a)).length).toBe(refs.length);
});

test("a throwing loadRefs never turns a PRE block into a throw (and is not even called)", async () => {
  let called = false;
  const boom = async () => { called = true; throw new Error("refs dir unreadable"); };
  const { out } = await run({ brainstorm: false, fresh: true, check1: true, doc: true, solid: true }, { loadRefs: boom });
  expect(out?.title).toBe(TITLES.fresh);
  expect(out?.reason).toContain(TITLES.doc);
  expect(called).toBe(false);
});

import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTrack, saveTrack, withTrack } from "../src/tracking/store";
import { appendEvent, foldEvents, signEvent, type TrackEvent } from "../src/tracking/track-journal";
import { COMPACT_BYTES, maybeCompactJournal, readEvents } from "../src/tracking/track-compact";
import { emptyTrack, recordRefRead } from "../src/tracking/session-state";
import { agentsFreshInTrack } from "../src/freshness/agent-evidence-record";
import { dir, logOf, withEnv } from "./helpers/track-env";

const BASE = 1_700_000_000_000;

test("append → replay: the fold table (union, per-key max, append, merge, LWW)", () => {
  const log = join(dir(), "track-a.log");
  appendEvent(log, "refsRead", "add", "a.md", BASE);
  appendEvent(log, "refsRead", "add", "a.md", BASE); // union dedups
  appendEvent(log, "refsReadAt", "max", ["a.md", BASE], BASE);
  appendEvent(log, "refsReadAt", "max", ["a.md", BASE - 5], BASE - 5); // max keeps the newer
  appendEvent(log, "agents", "append", { name: "x", ts: BASE }, BASE);
  appendEvent(log, "agents", "append", { name: "x", ts: BASE }, BASE); // never deduped
  appendEvent(log, "authorizations", "merge", { key: "react", entry: { doc_sessions: ["s1"], sources: ["exa"] } }, BASE);
  appendEvent(log, "authorizations", "merge", { key: "react", entry: { doc_sessions: ["s2"], sources: ["context7"] } }, BASE + 1);
  appendEvent(log, "brainstormRequired", "set", true, BASE);
  appendEvent(log, "brainstormRequired", "set", false, BASE + 1); // LWW on ts
  const t = foldEvents(readEvents(log));
  expect(t.refsRead).toEqual(["a.md"]);
  expect(t.refsReadAt).toEqual({ "a.md": BASE });
  expect(t.agents).toHaveLength(2);
  expect(t.authorizations.react).toMatchObject({ doc_sessions: ["s1", "s2"], sources: ["exa", "context7"] });
  expect(t.brainstormRequired).toBe(false);
});

test("fail-closed: an edited line fails the WHOLE journal explicitly (no valid sibling survives), junk lines are ignored", () => {
  const log = join(dir(), "track-b.log");
  appendEvent(log, "refsRead", "add", "good.md", BASE);
  appendEvent(log, "refsRead", "add", "good2.md", BASE + 1);
  const lines = readFileSync(log, "utf8").split("\n");
  const junked = [...lines.slice(0, 1), "not-json{{{", ...lines.slice(1)].join("\n");
  writeFileSync(log, junked, "utf8");
  expect(foldEvents(readEvents(log)).refsRead).toEqual(["good.md", "good2.md"]); // crash residue is not tampering
  const forged = JSON.parse(lines[0]!) as TrackEvent;
  forged.value = "evil.md"; // the MAC no longer matches
  writeFileSync(log, [JSON.stringify(forged), ...lines.slice(1)].join("\n"), "utf8");
  expect(readEvents(log)).toEqual([]); // before the chain: ["good2.md"] survived; now the break is explicit (see test/receipt-mac-binding.test.ts)
});

test("line cap: an oversized string value is truncated then signed — never an unsigned partial line", () => {
  const log = join(dir(), "track-c.log");
  const huge = "x".repeat(64 * 1024);
  expect(appendEvent(log, "refsRead", "add", huge, BASE)).toBe(true);
  for (const line of readFileSync(log, "utf8").trim().split("\n")) expect(line.length).toBeLessThan(32 * 1024);
  const [ev] = readEvents(log); // the MAC verifies over the TRUNCATED value
  expect(ev).toBeDefined();
  expect((ev!.value as string).length).toBeLessThan(huge.length);
  expect(signEvent("agents", "append", { blob: huge }, BASE)).toBeNull(); // oversized non-string dropped
});

test("migration: a legacy snapshot without a log reads as the base, events fold on top", async () => {
  const file = join(dir(), "track.json");
  await withEnv("0", async () => saveTrack(file, recordRefRead(emptyTrack(), "old.md", BASE)));
  await withEnv(undefined, async () => {
    expect((await loadTrack(file)).refsRead).toEqual(["old.md"]); // base alone, no log yet
    await withTrack(file, (t) => recordRefRead(t, "new.md", BASE + 1));
    expect((await loadTrack(file)).refsRead).toEqual(["old.md", "new.md"]); // snapshot ⊕ log
  });
});

test("collision: equal-ts agents MAY reorder (log order breaks ties) — the consumer stays invariant", () => {
  // Two sufficient agents with the SAME ts: fold follows the stable log order,
  // so swapped logs may yield swapped arrays — no array deep-equality here.
  const mk = (name: string): TrackEvent => signEvent("agents", "append", { name, ts: BASE, quality: "sufficient" }, BASE)!;
  const ab = foldEvents([mk("subagent-research-expert"), mk("subagent-explore-codebase")]);
  const ba = foldEvents([mk("subagent-explore-codebase"), mk("subagent-research-expert")]);
  const REQUIRED = ["research-expert", "explore-codebase"], NOW = BASE + 1000;
  for (const w of [120_000, 500]) expect(agentsFreshInTrack(ab, REQUIRED, w, NOW)).toBe(agentsFreshInTrack(ba, REQUIRED, w, NOW));
  expect(agentsFreshInTrack(ab, REQUIRED, 120_000, NOW)).toBe(true);
});

test("compaction: an oversized log folds into the signed snapshot, state preserved", async () => {
  await withEnv(undefined, async () => {
    const file = join(dir(), "track.json"), log = logOf(file);
    for (let i = 0; i < 1100; i++) appendEvent(log, "refsRead", "add", `/r/${i}.md`, BASE + i);
    for (let i = 0; i < 7; i++) appendEvent(log, "agents", "append", { name: `a${i}`, ts: BASE + i }, BASE + i);
    const before = await loadTrack(file);
    expect(before.refsRead).toHaveLength(1100);
    await maybeCompactJournal(file);
    expect(existsSync(file)).toBe(true); // signed snapshot rewritten
    expect(existsSync(`${log}.folding`)).toBe(false); // renamed-aside log consumed
    expect(existsSync(log)).toBe(false); // no appends raced us: nothing to keep
    const after = await loadTrack(file);
    expect(after).toEqual(before); // fold(snapshot ⊕ tail) == fold(all)
    expect(after.agents).toHaveLength(7); // R2a invariant: no event in BOTH snapshot and log (no double-count)
  });
});

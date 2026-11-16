/**
 * Bounded blocking append lock + lock-free spill: a hook must never wait
 * unboundedly on `track.lock`, and bounding the wait must never lose an event.
 */
import { test, expect } from "bun:test";
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTrack } from "../src/tracking/store";
import { appendEvent, signEvent } from "../src/tracking/track-journal";
import { journalLogPath, maybeCompactJournal } from "../src/tracking/track-compact";
import { sidOf } from "../src/tracking/track-chain";
import { captureSpills, listCapturedSpills, listSpills, spillEvent } from "../src/tracking/track-spill";
import { LOCK_FAILED, withTrackLockSyncBlocking } from "../src/tracking/track-lock-sync";
import { resolveTrackLockBudgetMs } from "../src/config/limits";
import { dir, withEnv } from "./helpers/track-env";

const BASE = 1_700_000_000_000;

async function withBudget<T>(ms: string, body: () => Promise<T>): Promise<T> {
  const prev = process.env.FUSE_TRACK_LOCK_BUDGET_MS;
  process.env.FUSE_TRACK_LOCK_BUDGET_MS = ms;
  try { return await body(); } finally {
    if (prev === undefined) delete process.env.FUSE_TRACK_LOCK_BUDGET_MS; else process.env.FUSE_TRACK_LOCK_BUDGET_MS = prev;
  }
}

test("budget resolver: default 1000, env override, clamped, garbage falls back", () => {
  expect(resolveTrackLockBudgetMs({})).toBe(1000);
  expect(resolveTrackLockBudgetMs({ FUSE_TRACK_LOCK_BUDGET_MS: "300" })).toBe(300);
  expect(resolveTrackLockBudgetMs({ FUSE_TRACK_LOCK_BUDGET_MS: "1" })).toBe(50);
  expect(resolveTrackLockBudgetMs({ FUSE_TRACK_LOCK_BUDGET_MS: "999999" })).toBe(8000);
  expect(resolveTrackLockBudgetMs({ FUSE_TRACK_LOCK_BUDGET_MS: "abc" })).toBe(1000);
});

test("withTrackLockSyncBlocking: held lock -> LOCK_FAILED within budget, fn NOT run; free lock -> fn result", () => {
  const d = dir();
  expect(withTrackLockSyncBlocking(d, () => 7, 100)).toBe(7);
  writeFileSync(join(d, "track.lock"), "held"); // fresh mtime: never stale
  let ran = false;
  const t0 = Date.now();
  expect(withTrackLockSyncBlocking(d, () => { ran = true; return 1; }, 150)).toBe(LOCK_FAILED);
  const dt = Date.now() - t0;
  expect(ran).toBe(false);
  expect(dt).toBeGreaterThanOrEqual(140);
  expect(dt).toBeLessThan(600);
});

test("held lock: appendEvent returns true within budget AND the event is visible to the next load", async () => {
  await withEnv(undefined, async () => withBudget("100", async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    appendEvent(log, "refsRead", "add", "a.md", BASE); // creates the .key + log
    writeFileSync(join(d, "track.lock"), "held");
    const t0 = Date.now();
    expect(appendEvent(log, "refsRead", "add", "spilled.md", BASE + 1)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500); // RED before: spins until the 10 s stale TTL
    expect(listSpills(log).length).toBe(1);
    expect((await loadTrack(file)).refsRead.sort()).toEqual(["a.md", "spilled.md"]);
  }));
});

test("compaction absorbs spills: snapshot holds them, spill files deleted only after the fold, nothing duplicated", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    appendEvent(log, "agents", "append", { n: "log" }, BASE);
    for (let i = 0; i < 3; i++) spillEvent(log, signEvent("agents", "append", { n: `s${i}` }, BASE + 1 + i, sidOf(log))!);
    expect((await loadTrack(file)).agents.length).toBe(4); // log + spills visible pre-compaction
    await maybeCompactJournal(file); // spills alone trigger the absorb
    expect(listSpills(log).length + listCapturedSpills(log).length).toBe(0);
    expect(existsSync(`${log}.folding`)).toBe(false);
    expect(JSON.stringify((await loadTrack(file)).agents.map((a) => (a as unknown as { n: string }).n))).toBe('["log","s0","s1","s2"]');
  });
});

test("crash AFTER the snapshot write but BEFORE the spill unlink: recovery re-fold is idempotent (no double count)", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    for (let i = 0; i < 3; i++) spillEvent(log, signEvent("agents", "append", { n: `s${i}` }, BASE + i, sidOf(log))!);
    const keep = listSpills(log);
    for (const p of keep) copyFileSync(p, `${p}.bak`);
    await maybeCompactJournal(file); // folds + deletes: the snapshot now holds s0..s2
    for (const p of keep) copyFileSync(`${p}.bak`, `${p}.folding`); // the unlink "never happened": captured residue
    expect(listCapturedSpills(log).length).toBe(3);
    await maybeCompactJournal(file); // recovery must skip the already-folded nonces (RED before: agents x2)
    const names = (await loadTrack(file)).agents.map((a) => (a as unknown as { n: string }).n);
    expect(names).toEqual(["s0", "s1", "s2"]);
    expect(listCapturedSpills(log).length).toBe(0);
  });
});

test("crash between spill write and fold loses nothing (pending, captured, and half-written tmp)", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    appendEvent(log, "agents", "append", { n: "base" }, BASE);
    spillEvent(log, signEvent("agents", "append", { n: "crash1" }, BASE + 1, sidOf(log))!);
    writeFileSync(`${log}.spill.${BASE}-1-abc.tmp`, '{"truncated'); // crash mid-write: never published
    expect((await loadTrack(file)).agents.length).toBe(2); // pending spill survives, tmp ignored
    captureSpills(log); // crash AFTER capture, BEFORE fold: events live only in `.folding`
    expect(listCapturedSpills(log).length).toBe(1);
    await maybeCompactJournal(file); // next run recovers the captured spill first
    const names = (await loadTrack(file)).agents.map((a) => (a as unknown as { n: string }).n);
    expect(names.sort()).toEqual(["base", "crash1"]); // exactly once each
    expect(readdirSync(d).filter((n) => n.includes(".folding") || /\.spill\.[0-9]+-[0-9]+-[0-9a-f]+$/.test(n))).toEqual([]);
  });
});

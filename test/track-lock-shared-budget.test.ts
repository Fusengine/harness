/**
 * One shared wait budget (`FUSE_TRACK_LOCK_BUDGET_MS`, default 1000 ms) for EVERY
 * track-lock taker. Before, the async/sync twins gave up after a private 400 ms
 * with a fixed 8 ms poll (the H3 CI flake: compaction "write skipped"), and the
 * legacy `FUSE_TRACK_JOURNAL=0` path dropped the write outright. A holder that
 * keeps the lock for 600 ms (a big compaction) must now be WAITED OUT, and past
 * the budget a track write is spilled (readable), never dropped.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadTrack, withTrack } from "../src/tracking/store";
import { appendEvent } from "../src/tracking/track-journal";
import { journalLogPath, maybeCompactJournal, readTrackSync } from "../src/tracking/track-compact";
import { LOCK_FAILED, withTrackLock } from "../src/tracking/track-lock";
import { withTrackLockSync } from "../src/tracking/track-lock-sync";
import { listSpills } from "../src/tracking/track-spill";
import { updateTrackSync } from "../src/freshness/evidence-harvest-io";
import type { SessionTrack } from "../src/tracking/session-state";
import { dir, withEnv } from "./helpers/track-env";

const BASE = 1_700_000_000_000;
const quiet = async <T>(body: () => Promise<T> | T): Promise<T> => {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await body(); } finally { process.stderr.write = orig; }
};

/** Hold `<d>/track.lock` from ANOTHER process for `ms`; resolves once the lock is really held, `done` once released. */
async function holdLock(d: string, ms: number): Promise<{ done: Promise<void> }> {
  const lock = join(d, "track.lock");
  const script = `import { openSync, closeSync, unlinkSync } from "node:fs";
closeSync(openSync(${JSON.stringify(lock)}, "wx")); process.stdout.write("held\\n");
setTimeout(() => { unlinkSync(${JSON.stringify(lock)}); process.exit(0); }, ${ms});`;
  const p = spawn("bun", ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((r) => p.on("close", () => r()));
  await new Promise<void>((r) => p.stdout!.once("data", () => r()));
  return { done };
}

test("async withTrackLock waits out a 600 ms holder (shared 1000 ms budget), fn runs", async () => {
  const d = dir(), h = await holdLock(d, 600);
  expect(await withTrackLock(d, async () => "ran")).toBe("ran");
  await h.done;
});

test("withTrackLockSync waits out a 600 ms holder (shared 1000 ms budget), fn runs", async () => {
  const d = dir(), h = await holdLock(d, 600);
  expect(withTrackLockSync(d, () => "ran")).toBe("ran");
  await h.done;
});

test("maybeCompactJournal waits out a 600 ms holder and reports `compacted` (never a silent skip)", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    for (let i = 0; i < 5; i++) appendEvent(log, "refsRead", "add", `r-${i}.md`, BASE + i);
    process.env.FUSE_TRACK_COMPACT_BYTES = "1";
    try {
      const h = await holdLock(d, 600);
      expect(await maybeCompactJournal(file)).toBe("compacted");
      await h.done;
    } finally { delete process.env.FUSE_TRACK_COMPACT_BYTES; }
    expect((await loadTrack(file)).refsRead.length).toBe(5);
  });
});

test("maybeCompactJournal past the budget returns `skipped` as a STATUS (no throw, no lost event)", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    for (let i = 0; i < 5; i++) appendEvent(log, "refsRead", "add", `r-${i}.md`, BASE + i);
    process.env.FUSE_TRACK_COMPACT_BYTES = "1";
    process.env.FUSE_TRACK_LOCK_BUDGET_MS = "100";
    try {
      const h = await holdLock(d, 500);
      expect(await quiet(() => maybeCompactJournal(file))).toBe("skipped");
      await h.done;
    } finally { delete process.env.FUSE_TRACK_COMPACT_BYTES; delete process.env.FUSE_TRACK_LOCK_BUDGET_MS; }
    expect((await loadTrack(file)).refsRead.length).toBe(5);
  });
});

test("legacy FUSE_TRACK_JOURNAL=0 withTrack waits out a 600 ms holder and the write lands in the snapshot", async () => {
  await withEnv("0", async () => {
    const d = dir(), file = join(d, "track.json"), h = await holdLock(d, 600);
    expect(await withTrack(file, (t) => ({ ...t, refsRead: ["a.md"] }))).toBe(true);
    await h.done;
    expect((await loadTrack(file)).refsRead).toEqual(["a.md"]);
  });
});

test("legacy withTrack past the budget SPILLS the write (readable by the journal), never drops it", async () => {
  await withEnv("0", async () => {
    const d = dir(), file = join(d, "track.json");
    process.env.FUSE_TRACK_LOCK_BUDGET_MS = "100";
    try {
      const h = await holdLock(d, 500);
      expect(await quiet(() => withTrack(file, (t) => ({ ...t, refsRead: ["lost-before.md"] })))).toBe(false); // not applied to the snapshot
      await h.done;
    } finally { delete process.env.FUSE_TRACK_LOCK_BUDGET_MS; }
    expect(listSpills(journalLogPath(file)).length).toBeGreaterThan(0);
    expect(readTrackSync(file, true).refsRead).toEqual(["lost-before.md"]); // recoverable via journal mode
  });
});

test("sync legacy caller (updateTrackSync, kill-switch) loses no write: waits a 600 ms holder; past the budget it spills", async () => {
  await withEnv("0", async () => {
    const mut = (ref: string) => (t: SessionTrack): SessionTrack => ({ ...t, refsRead: [...t.refsRead, ref] });
    const d = dir(), file = join(d, "track.json"), h = await holdLock(d, 600);
    updateTrackSync(file, BASE, mut("waited.md"));
    await h.done;
    expect(readTrackSync(file, false).refsRead).toEqual(["waited.md"]); // landed in the snapshot
    process.env.FUSE_TRACK_LOCK_BUDGET_MS = "100";
    try {
      const h2 = await holdLock(d, 500);
      await quiet(() => updateTrackSync(file, BASE + 1, mut("spilled.md")));
      await h2.done;
    } finally { delete process.env.FUSE_TRACK_LOCK_BUDGET_MS; }
    expect(readTrackSync(file, true).refsRead.sort()).toEqual(["spilled.md", "waited.md"]); // journal view = snapshot ⊕ spill
  });
});

test("withTrackLock still returns LOCK_FAILED past a short budget (bounded, never unbounded)", async () => {
  const d = dir();
  process.env.FUSE_TRACK_LOCK_BUDGET_MS = "100";
  try {
    const h = await holdLock(d, 400);
    expect(await quiet(() => withTrackLock(d, async () => "no"))).toBe(LOCK_FAILED); // gave up while the holder still held (400 ms > 100 ms budget)
    await h.done;
  } finally { delete process.env.FUSE_TRACK_LOCK_BUDGET_MS; }
});

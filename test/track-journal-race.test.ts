import { test, expect } from "bun:test";
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadTrack } from "../src/tracking/store";
import { appendEvent } from "../src/tracking/track-journal";
import { journalLogPath, maybeCompactJournal } from "../src/tracking/track-compact";
import { dir, STORE, TCOMPACT, TJOURNAL, withEnv } from "./helpers/track-env";

const BASE = 1_700_000_000_000;

/**
 * H3 regression probe — NON-VACANT by construction. The compaction cap is
 * injected (FUSE_TRACK_COMPACT_BYTES=32K) so it fires ~9 times during the
 * run; the prefill (raw appendEvent — never triggers compaction) stops just
 * UNDER the cap, asserted on disk (no snapshot exists yet). The 8 workers ×
 * 200 withTrack writes then push the log PAST the cap repeatedly WHILE the
 * other processes keep appending — the exact window the old truncate-rewrite
 * compactSync lost writes in (measured: 1-6 lost per run, 5/5 red; the
 * rename-atomic compaction: 0 lost, 5/5 green). Final read rebuilds EVERY ref.
 */
test("H3 race: compaction fires DURING concurrent appends — 0 lost write", async () => {
  await withEnv(undefined, async () => {
    const file = join(dir(), "track.json"), home = dir();
    const PRE = 100, WORKERS = 8, PER = 200, CAP = 32 * 1024;
    const script = `import { withTrack, loadTrack } from ${JSON.stringify(STORE)};
import { appendEvent } from ${JSON.stringify(TJOURNAL)};
import { journalLogPath } from ${JSON.stringify(TCOMPACT)};
const file = ${JSON.stringify(file)}, id = process.env.WORKER_ID;
if (id === "v") { process.stdout.write(JSON.stringify((await loadTrack(file)).refsRead)); process.exit(0); }
if (id === "pre") { const log = journalLogPath(file); for (let i = 0; i < ${PRE}; i++) appendEvent(log, "refsRead", "add", "pre-" + i + ".md", ${BASE} + i); process.exit(0); }
for (let i = 0; i < ${PER}; i++) await withTrack(file, (t) => ({ ...t, refsRead: [...t.refsRead, id + "-" + i + ".md"] }));
process.exit(0);`;
    const run = (id: string) =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const p = spawn("bun", ["-e", script], { env: { ...process.env, HOME: home, WORKER_ID: id, FUSE_TRACK_COMPACT_BYTES: String(CAP) } });
        let out = "", err = "";
        p.stdout!.on("data", (c: Buffer) => (out += c.toString()));
        p.stderr!.on("data", (c: Buffer) => (err += c.toString()));
        p.on("close", (code) => done({ code, out, err }));
      });
    expect((await run("pre")).code).toBe(0); // same hermetic HOME → same .key
    // Setup proof: cap NOT crossed yet, compaction NOT fired — the concurrent
    // phase alone can trigger it (otherwise this test guards nothing).
    const size = statSync(journalLogPath(file)).size;
    expect(size).toBeGreaterThan(CAP - 16 * 1024);
    expect(size).toBeLessThan(CAP);
    expect(existsSync(file)).toBe(false);
    const rs = await Promise.all(Array.from({ length: WORKERS }, (_, i) => run(`w${i}`)));
    for (const r of rs) { expect(r.code).toBe(0); expect(r.err).not.toContain("write skipped"); }
    const v = await run("v");
    expect(v.code).toBe(0);
    const refs = JSON.parse(v.out) as string[];
    expect(refs.length).toBe(PRE + WORKERS * PER); // compaction raced the appends: ZERO lost
    expect(new Set(refs).size).toBe(refs.length);
  });
});

test("compaction recovery: a stale .folding (crashed compaction) is re-folded first, 0 loss", async () => {
  await withEnv(undefined, async () => {
    const file = join(dir(), "track.json"), log = journalLogPath(file);
    for (let i = 0; i < 5; i++) appendEvent(log, "refsRead", "add", `stale-${i}.md`, BASE - 100 + i);
    renameSync(log, `${log}.folding`); // a crashed compaction left its capture behind (chained: seq 1..5)
    for (let i = 0; i < 1100; i++) appendEvent(log, "refsRead", "add", `live-${i}.md`, BASE + i); // the chain continues from the head file
    await maybeCompactJournal(file);
    expect(existsSync(`${log}.folding`)).toBe(false);
    expect((await loadTrack(file)).refsRead).toHaveLength(1105); // residue AND live log folded
  });
});

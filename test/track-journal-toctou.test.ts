/**
 * Deterministic probes for the append/compaction TOCTOU (the publish-CI lost
 * write: an append preempted between open and write while compaction ran
 * rename → fold → unlink landed in the renamed inode and was unlinked).
 * Test A is the non-regression guard (the real appendEvent must BLOCK on
 * track.lock). Test B runs the REAL integration cross-process: a real
 * appendEvent loop executing WHILE a real maybeCompactJournal compacts the
 * same dir — it must serialise behind the compaction and lose nothing.
 */
import { test, expect } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { computeMac, loadOrCreateKey } from "../src/tracking/integrity";
import { loadTrack } from "../src/tracking/store";
import { appendEvent } from "../src/tracking/track-journal";
import { journalLogPath, maybeCompactJournal } from "../src/tracking/track-compact";
import { dir, TJOURNAL, withEnv } from "./helpers/track-env";

const BASE = 1_700_000_000_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await sleep(25);
  }
}

test("A) appendEvent BLOCKS on track.lock (mutual exclusion with compaction) — deterministic", async () => {
  await withEnv(undefined, async () => {
    const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
    appendEvent(log, "refsRead", "add", "a.md", BASE);
    writeFileSync(join(d, "track.lock"), "held"); // same lockfile the compaction takes
    const script = `import { appendEvent } from ${JSON.stringify(TJOURNAL)};
process.stdout.write("READY\\n");
appendEvent(${JSON.stringify(log)}, "refsRead", "add", "probe.md", ${BASE + 1});
process.stdout.write("APPENDED\\n");`;
    const p = spawn("bun", ["-e", script], { env: { ...process.env } }); // inherited HOME → same .key
    let out = "";
    p.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    const exit = new Promise<number | null>((done) => p.on("close", done));
    await waitFor(() => out.includes("READY"), 10_000); // child sits AT the append point
    await sleep(400); // an unlocked append would have landed long ago
    expect(out).not.toContain("APPENDED"); // RED before the fix: bare appendFileSync ignores the lock
    rmSync(join(d, "track.lock")); // release: the blocked append must now proceed
    expect(await exit).toBe(0);
    expect(out).toContain("APPENDED");
    expect((await loadTrack(file)).refsRead).toContain("probe.md"); // 0 loss
  });
});

test("B) real appendEvent loop DURING a real maybeCompactJournal: serialises, 0 loss — deterministic", async () => {
  await withEnv(undefined, async () => {
    const prevCap = process.env.FUSE_TRACK_COMPACT_BYTES;
    process.env.FUSE_TRACK_COMPACT_BYTES = "1"; // the real compaction fires immediately
    try {
      const d = dir(), file = join(d, "track.json"), log = journalLogPath(file);
      const PRE = 20_000, N = 2_000;
      // Seed the PRE-event backlog (the ~500 ms fold window) with ONE write of correctly signed lines — the same
      // on-disk format appendEvent produces — instead of 20k lock+key-read+append round trips (~4 s under load,
      // which is what blew the 5 s budget). The race under test (appends DURING the compaction) is unchanged.
      const key = loadOrCreateKey();
      const lines: string[] = [];
      for (let i = 0; i < PRE; i++) {
        const nonce = randomBytes(8).toString("hex");
        const ev = { field: "refsRead", op: "add", value: `pre-${i}.md`, ts: BASE + i };
        lines.push(JSON.stringify({ v: 1, ...ev, nonce, mac: computeMac(key, JSON.stringify(ev), nonce) }));
      }
      writeFileSync(log, lines.join("\n") + "\n");
      const go = join(d, "go");
      const script = `import { appendEvent } from ${JSON.stringify(TJOURNAL)};
import { existsSync } from "node:fs";
process.stdout.write("READY\\n");
while (!existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < ${N}; i++) appendEvent(${JSON.stringify(log)}, "refsRead", "add", "b-" + i + ".md", ${BASE} + i);
process.stdout.write("DONE " + Date.now() + "\\n");`;
      const p = spawn("bun", ["-e", script], { env: { ...process.env } }); // inherited HOME → same .key
      let out = "";
      p.stdout!.on("data", (c: Buffer) => (out += c.toString()));
      const exit = new Promise<number | null>((done) => p.on("close", done));
      await waitFor(() => out.includes("READY"), 10_000);
      writeFileSync(go, "1"); // release the appender INTO the compaction window
      await maybeCompactJournal(file); // REAL compaction: rename → fold 20k lines → unlink
      const compactEnd = Date.now();
      expect(await exit).toBe(0);
      const doneTs = Number(out.match(/DONE (\d+)/)?.[1]);
      // Without the append lock the loop finishes ~200 ms after GO, deep INSIDE
      // the ~600 ms compaction → doneTs < compactEnd (RED). With it, the loop
      // blocks on track.lock until the compaction releases → doneTs > compactEnd.
      expect(doneTs).toBeGreaterThan(compactEnd);
      const refs = (await loadTrack(file)).refsRead;
      expect(refs.length).toBe(PRE + N); // 0 perte
      expect(refs).toContain(`b-${N - 1}.md`);
    } finally {
      if (prevCap === undefined) delete process.env.FUSE_TRACK_COMPACT_BYTES;
      else process.env.FUSE_TRACK_COMPACT_BYTES = prevCap;
    }
  });
}, 30_000); // each append is chained (+tail read, +head write ≈ 0.2 ms): the 22k-line setup outgrew the 5 s default

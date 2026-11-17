/**
 * Compaction must not starve behind continuous appenders. Root cause of the
 * H3 CI flake ("track lock busy, write skipped"): `maybeCompactJournal` took
 * the lock with the async 8 ms fixed-step poll while appenders re-took it
 * every ~0.5 ms, so the rare lock taker lost every race inside its budget.
 * Here N tight-loop appenders run while a compactor process forces a
 * compaction pass repeatedly; every pass must report `compacted`, none may
 * log "write skipped", and not one appended event may be lost.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { dir, STORE, TCOMPACT, TJOURNAL } from "./helpers/track-env";

/** Scaled to the machine (2 per core, 8..24): a 4-vCPU runner must not be oversubscribed into a timing flake. */
const APPENDERS = Math.min(24, Math.max(8, availableParallelism() * 2)), PASSES = 30;

type Out = { code: number | null; out: string; err: string };

function run(script: string, env: Record<string, string>): Promise<Out> {
  return new Promise((done) => {
    const p = spawn("bun", ["-e", script], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout!.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr!.on("data", (c: Buffer) => (err += c.toString()));
    p.on("close", (code) => done({ code, out, err }));
  });
}

test("compaction is never starved by continuous appenders: every pass compacts, 0 skipped, 0 lost", async () => {
  const file = join(dir(), "track.json"), home = dir(), stop = join(dir(), "stop");
  const appender = `import { appendEvent } from ${JSON.stringify(TJOURNAL)};
import { journalLogPath } from ${JSON.stringify(TCOMPACT)};
import { existsSync } from "node:fs";
const log = journalLogPath(${JSON.stringify(file)}), id = process.env.WORKER_ID; let n = 0;
while (!existsSync(${JSON.stringify(stop)})) { if (appendEvent(log, "refsRead", "add", id + "-" + n + ".md", 1700000000000 + n)) n++; }
process.stdout.write(String(n)); process.exit(0);`;
  const compactor = `import { maybeCompactJournal } from ${JSON.stringify(TCOMPACT)};
let skipped = 0, compacted = 0;
const orig = process.stderr.write.bind(process.stderr);
process.stderr.write = ((s: string) => { if (String(s).includes("write skipped")) skipped++; return true; }) as never;
for (let i = 0; i < ${PASSES}; i++) { const st = await maybeCompactJournal(${JSON.stringify(file)}); if (st === "compacted") compacted++; await new Promise((r) => setTimeout(r, 20)); }
orig(JSON.stringify({ skipped, compacted }) + "\\n"); process.exit(0);`;
  const reader = `import { loadTrack } from ${JSON.stringify(STORE)};
process.stdout.write(JSON.stringify((await loadTrack(${JSON.stringify(file)})).refsRead)); process.exit(0);`;
  const env = { HOME: home, FUSE_TRACK_COMPACT_BYTES: "1" };
  const apps = Array.from({ length: APPENDERS }, (_, i) => run(appender, { ...env, WORKER_ID: `a${i}` }));
  await new Promise((r) => setTimeout(r, 300)); // appenders hot before the first compaction pass
  const c = await run(compactor, env);
  writeFileSync(stop, "");
  const results = await Promise.all(apps);
  expect(existsSync(stop)).toBe(true);
  for (const r of results) expect(r.code).toBe(0);
  expect(c.code).toBe(0);
  const stat = JSON.parse(c.err.trim().split("\n").pop()!) as { skipped: number; compacted: number };
  expect(stat.skipped).toBe(0);
  expect(stat.compacted).toBe(PASSES);
  const total = results.reduce((a, r) => a + Number(r.out), 0);
  const refs = JSON.parse((await run(reader, env)).out) as string[];
  expect(refs.length).toBe(total); // every acknowledged append survived the compactions
  expect(new Set(refs).size).toBe(total);
}, 60000);

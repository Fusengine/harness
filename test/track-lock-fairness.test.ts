/**
 * Fairness of the blocking track lock: 8 processes hammering one lock must all
 * finish inside the (unchanged) 1000 ms budget. A bare `wx` lock lets the releaser
 * re-take it microseconds later, starving sleeping waiters (Motion D5 Publish flake).
 * The 5 ms hold models a slow-disk critical section: before the step-aside fix this
 * shape produced LOCK_FAILED in every run; the real D5 hold is ~0.3 ms.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WORKERS = 8, ITERATIONS = 40, HOLD_MS = 5, BUDGET_MS = 1000;

/** Spawn one worker that waits for the barrier, then takes the lock ITERATIONS times; resolves its LOCK_FAILED count. */
function worker(id: number, dir: string, home: string, barrier: string): Promise<number> {
  const script = `import {withTrackLockSyncBlocking,LOCK_FAILED} from ${JSON.stringify(resolve("src/tracking/track-lock-sync.ts"))};
    import {existsSync,writeFileSync} from 'node:fs';
    const id=${id};
    writeFileSync(${JSON.stringify(home)}+'/ready-'+id,'');
    const deadline=Date.now()+8000;
    while(!existsSync(${JSON.stringify(barrier)})) { if(Date.now()>deadline) process.exit(2); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2); }
    let fail=0;
    for(let i=0;i<${ITERATIONS};i++) {
      const r=withTrackLockSyncBlocking(${JSON.stringify(dir)},()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${HOLD_MS});return 1;},${BUDGET_MS});
      if(r===LOCK_FAILED) fail++;
    }
    console.log(fail);`;
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home } });
    const out: string[] = [], err: string[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => err.push(d.toString()));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker timed out")); }, 9000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`worker exited ${code}: ${err.join("")}`));
      else resolveWorker(Number(out.join("").trim()));
    });
  });
}

test("track lock fairness: 8 concurrent writers, 5 ms hold, 0 LOCK_FAILED within the unchanged 1000 ms budget", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fh-lockfair-home-")));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fh-lockfair-dir-")));
  const barrier = join(home, "start");
  const runs = Array.from({ length: WORKERS }, (_, i) => worker(i, dir, home, barrier));
  const deadline = Date.now() + 8000;
  while (!Array.from({ length: WORKERS }, (_, i) => existsSync(join(home, `ready-${i}`))).every(Boolean)) {
    if (Date.now() > deadline) throw new Error("workers not ready");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  writeFileSync(barrier, "");
  const fails = await Promise.all(runs);
  expect(fails).toEqual(Array(WORKERS).fill(0));
  expect(existsSync(join(dir, "track.lock"))).toBe(false); // every holder released
}, 10000);

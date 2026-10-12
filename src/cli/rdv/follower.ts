/**
 * Rendezvous entry for ONE hook process: arrive, register, then either lead,
 * wait for the leader's answer, or fall back to the standalone path.
 *
 * Light on purpose: this file (and what it imports) runs in EVERY hook process
 * before the heavy runtime is loaded. The leader body is injected (`lead`).
 *
 * Degradation rule: ANY thrown fault (disk full, EACCES, corrupt file…) and every
 * "cannot be served" state returns `standalone` — never an empty or allow output.
 * Exactly one process ever runs a registration's scope: whoever creates its
 * `claim-` file (the leader just before running it, or the owner when it steals).
 */
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { ageMs, eventKey, exists, pidAlive, readText, sleepSync, tryExclusive, tryExclusiveWith, writeAtomic } from "./fs";
import { layout, regName } from "./layout";
import { registrationEnv } from "../../runtime/inject-session/loader-child";
import type { RdvContext, RdvOutcome, Registration, ResultFile, UnitResult } from "./types";

/** Runs the leader loop; resolves to the leader's OWN result. Injected by the caller. */
export type LeadFn = (ctx: RdvContext, dir: string, ownName: string) => Promise<UnitResult | null>;

const NEVER = Number.POSITIVE_INFINITY;

/** Move a stale generation aside (atomic) and delete it; losing the race is fine. */
function gcDir(dir: string): void {
  const aside = `${dir}.gc-${process.pid}-${Date.now()}`;
  try { renameSync(dir, aside); } catch { return; }
  try { rmSync(aside, { recursive: true, force: true }); } catch { /* the leader's sweep removes leftovers */ }
}

/** Pid recorded in the `leader` file, or NaN while unreadable. */
function leaderPidOf(dir: string): number {
  return Number((readText(layout.leader(dir)) ?? "").split(":")[0]);
}

/**
 * Create/enter the event dir. False when this process must run standalone:
 * the set is already closed (late arrival) or its leader crashed moments ago.
 */
function enterDir(ctx: RdvContext, dir: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    mkdirSync(dir, { recursive: true });
    const closedAge = ageMs(layout.closed(dir));
    if (closedAge === NEVER) {
      if (!exists(layout.leader(dir)) || pidAlive(leaderPidOf(dir))) return true;
      if (ageMs(layout.leader(dir)) <= ctx.tuning.staleMs) return false; // fresh crash
    } else if (closedAge <= ctx.tuning.staleMs) {
      return false; // set already closed: late arrival
    }
    gcDir(dir); // stale generation: restart clean
  }
  return false;
}

/** Parse a result file, or null when absent/corrupt. */
function readResult(dir: string, name: string): ResultFile | null {
  const text = readText(layout.res(dir, name));
  if (text === null) return null;
  try { return JSON.parse(text) as ResultFile; } catch { return null; }
}

/** Map a result file to an outcome. */
function toOutcome(res: ResultFile): RdvOutcome {
  if (res.kind === "decline") return { kind: "standalone", why: "declined" };
  return { kind: "result", role: "follower", result: { stdout: res.stdout, stderr: res.stderr, exit: res.exit } };
}

/** Follower wait loop: result, steal, or standalone — whichever comes first. */
function waitForResult(ctx: RdvContext, dir: string, name: string): RdvOutcome {
  const t0 = Date.now();
  const { stealMs, hardMs, pollMs } = ctx.tuning;
  for (;;) {
    const res = readResult(dir, name);
    if (res) return toOutcome(res);
    const elapsed = Date.now() - t0;
    if (elapsed >= stealMs && !exists(layout.claim(dir, name)) && tryExclusive(layout.claim(dir, name), String(process.pid))) {
      return { kind: "standalone", why: "unclaimed" };
    }
    const pid = leaderPidOf(dir);
    if (!Number.isNaN(pid) && !pidAlive(pid)) {
      const late = readResult(dir, name); // the leader may have answered just before exiting
      return late ? toOutcome(late) : { kind: "standalone", why: "leader-dead" };
    }
    if (elapsed >= hardMs) return { kind: "standalone", why: "hard-bound" };
    sleepSync(pollMs);
  }
}

/**
 * Join the rendezvous of this event.
 * @param ctx - The process's identity, payload and tuning.
 * @param lead - Leader body (heavy; loaded only by the winner).
 * @returns The result to print, or `standalone` when the caller must run its own scope.
 */
export async function rendezvous(ctx: RdvContext, lead: LeadFn): Promise<RdvOutcome> {
  try {
    const dir = `${ctx.root}/${eventKey(ctx.id, ctx.cwd, ctx.text)}`;
    if (!enterDir(ctx, dir)) return { kind: "standalone", why: "late-or-dead" };
    const isLeader = tryExclusiveWith(layout.leader(dir), `${process.pid}:${Date.now()}`);
    const name = regName();
    const reg: Registration = { id: ctx.id, scopeArg: ctx.scopeArg, pid: process.pid, env: registrationEnv(ctx.id, ctx.env) };
    writeAtomic(layout.reg(dir, name), JSON.stringify(reg));
    if (isLeader) {
      const own = await lead(ctx, dir, name);
      return own ? { kind: "result", role: "leader", result: own } : { kind: "standalone", why: "leader-own-scope" };
    }
    // Registered after the leader closed the set? It may or may not have seen us: the claim decides.
    if (exists(layout.closed(dir)) && tryExclusive(layout.claim(dir, name), String(process.pid))) {
      return { kind: "standalone", why: "registered-after-close" };
    }
    return waitForResult(ctx, dir, name);
  } catch (e) {
    return { kind: "standalone", why: `fault:${e instanceof Error ? e.message : String(e)}` };
  }
}

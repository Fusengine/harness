/**
 * @module inject-session/units
 * Unit files of one registry epoch (see {@link module:inject-session/registry}):
 *   - `<n>.d.<hash>`  unit delivered (exclusive create = atomic claim across processes)
 *   - `<n>.q.<hash>`  unit parked by the per-event size cap (JSON `{o, t}`), written atomically
 *   - `<n>.l.<slot>`  latest hash seen in a producer slot (producer + event + position), so a
 *                     change A -> B -> A is detected and A redelivered
 * Write failures THROW (callers fail open and print the full original block);
 * a claim that fails for any reason other than "already claimed" counts as won.
 */
import { createHash } from "node:crypto";
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentEpoch, scopeRoot, type Scope } from "./registry";

/** A unit parked by the size cap. */
export interface Queued {
  /** Sort key (arrival order). */
  o: number;
  /** Unit text. */
  t: string;
  /** Hash (file suffix). */
  h: string;
}

const doneFile = (s: Scope, h: string): string => join(s.root, `${s.epoch}.d.${h}`);
const parkFile = (s: Scope, h: string): string => join(s.root, `${s.epoch}.q.${h}`);

/** Filesystem-safe short key of a slot name. */
export function slotKey(slot: string): string {
  return createHash("sha1").update(slot).digest("hex").slice(0, 16);
}

/** Atomically claim delivery of `hash`; true only for the single winner across processes. */
export function claim(s: Scope, hash: string): boolean {
  try {
    writeFileSync(doneFile(s, hash), "", { flag: "wx" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

/** Forget that `hash` was delivered (its slot changed, so a later return to it must be redelivered). */
export function release(s: Scope, hash: string): void {
  try { unlinkSync(doneFile(s, hash)); } catch { /* not delivered / already released */ }
}

/** True when the unit was already delivered or is waiting in the park. */
export function known(s: Scope, hash: string): boolean {
  return existsSync(doneFile(s, hash)) || existsSync(parkFile(s, hash));
}

/** True when the unit is waiting in the park. */
export function isParked(s: Scope, hash: string): boolean {
  return existsSync(parkFile(s, hash));
}

/** Latest hash recorded for a slot, or undefined. */
export function getSlot(s: Scope, slot: string): string | undefined {
  try { return readFileSync(join(s.root, `${s.epoch}.l.${slotKey(slot)}`), "utf-8") || undefined; } catch { return undefined; }
}

/** Record the latest hash of a slot (atomic replace). */
export function setSlot(s: Scope, slot: string, hash: string): void {
  const tmp = join(s.root, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, hash);
  renameSync(tmp, join(s.root, `${s.epoch}.l.${slotKey(slot)}`));
}

/** Park a unit for a later event, atomically (temp file + exclusive link); a no-op when already parked. Throws on any other failure. */
export function enqueue(s: Scope, hash: string, text: string, order: number): void {
  const tmp = join(s.root, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify({ o: order, t: text }));
  try {
    linkSync(tmp, parkFile(s, hash));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Parked units of the current epoch, in arrival order. A file that does not parse is corrupt: it is deleted (the unit is unknown again, so it gets re-derived). */
export function queued(s: Scope): Queued[] {
  const out: Queued[] = [];
  let names: string[] = [];
  try { names = readdirSync(s.root); } catch { return out; }
  for (const n of names) {
    if (!n.startsWith(`${s.epoch}.q.`)) continue;
    try {
      const v = JSON.parse(readFileSync(join(s.root, n), "utf-8")) as { o?: unknown; t?: unknown };
      if (typeof v.o !== "number" || typeof v.t !== "string") throw new Error("bad shape");
      out.push({ o: v.o, t: v.t, h: n.slice(`${s.epoch}.q.`.length) });
    } catch {
      try { unlinkSync(join(s.root, n)); } catch { /* sibling removed it */ }
    }
  }
  return out.sort((a, b) => a.o - b.o || (a.h < b.h ? -1 : 1));
}

/** Read-only, creates nothing: does the scope hold a parked unit in its current epoch? Cheap guard for the per-tool-call drain. */
export function hasParked(stateDir: string, name: string): boolean {
  const root = scopeRoot(stateDir, name);
  try {
    const cur = currentEpoch(root);
    return cur > 0 && readdirSync(root).some((n) => n.startsWith(`${cur}.q.`));
  } catch {
    return false;
  }
}

/** Remove a parked unit (delivered, or superseded). */
export function dequeue(s: Scope, hash: string): void {
  try { unlinkSync(parkFile(s, hash)); } catch { /* sibling removed it */ }
}

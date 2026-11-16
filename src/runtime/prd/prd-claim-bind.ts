/**
 * @module prd-claim-bind
 * Atomic check-and-set of PRD slot bindings in the per-session track. Two
 * concurrent hook processes claiming the same slot (or one agent claiming two)
 * are serialized by a DEDICATED claim lock; the loser re-reads the track, sees
 * the winner's binding and is refused. The claim lock is a separate lockfile
 * (its own sub-directory): the track write underneath takes `track.lock`
 * itself (journal append / legacy RMW), which must never be held already.
 * Works in journal and legacy mode alike (`withTrack` is mode-aware).
 */
import { dirname, join } from "node:path";
import { recordPrdOwner } from "../../tracking/session-state";
import { loadTrack, withTrack } from "../../tracking/store";
import { LOCK_FAILED, withTrackLock } from "../../tracking/track-lock";

/** One slot claim to commit. */
export interface SlotBind {
  agentId: string;
  name: string;
}

/** Outcome of {@link commitBinds}: committed, or the reason it was refused. */
export type CommitResult = { ok: true } | { ok: false; reason: string };

/**
 * Re-checks every claim against the FRESH track under the claim lock, then
 * persists them. Fails closed: a busy lock or a failed track write refuses the claim.
 * @param trackFilePath - The session track file.
 * @param binds - The claims decided by `resolveClaim` on a possibly stale snapshot.
 * @returns `{ok:true}` once every bind is persisted (or already held), else the refusal reason.
 */
export async function commitBinds(trackFilePath: string, binds: SlotBind[]): Promise<CommitResult> {
  if (binds.length === 0) return { ok: true };
  const ran = await withTrackLock(join(dirname(trackFilePath), "prd-claim"), async (): Promise<CommitResult> => {
    const owners = { ...((await loadTrack(trackFilePath)).prdOwners ?? {}) };
    const fresh: SlotBind[] = [];
    for (const bind of binds) {
      const held = owners[bind.agentId];
      if (held === bind.name) continue;
      if (held !== undefined) return { ok: false, reason: `you already own slot "${held}" — one slot per agent` };
      if (Object.values(owners).includes(bind.name)) return { ok: false, reason: `slot "${bind.name}" was just claimed by another agent` };
      owners[bind.agentId] = bind.name;
      fresh.push(bind);
    }
    if (fresh.length === 0) return { ok: true };
    const persisted = await withTrack(trackFilePath, (t) => fresh.reduce((acc, b) => recordPrdOwner(acc, b.agentId, b.name), t));
    return persisted ? { ok: true } : { ok: false, reason: "the claim could not be recorded (session track busy) — retry this write" };
  });
  return ran === LOCK_FAILED ? { ok: false, reason: "the claim lock is busy — retry this write" } : ran;
}

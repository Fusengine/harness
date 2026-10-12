/**
 * @module inject-session/deliver
 * Once-per-session, size-capped delivery of injected context. Given the text a
 * hook wants to inject, returns only what the model has not received yet in
 * this scope/epoch, never more than {@link UNIT_MAX} chars per call; the rest
 * is parked in the registry and delivered by later events (any hook event of
 * the same scope), preserving order.
 *
 * Dynamic content: every unit sits in a slot (producer + event + position). A
 * unit identical to what its slot last carried is skipped; when a slot's content
 * CHANGES (including a return to an earlier value, A -> B -> A) the new content
 * is delivered and any stale parked version of the old content is dropped. Content
 * first seen in a slot is skipped only if the same text was already delivered
 * elsewhere in the epoch (e.g. rules at SessionStart, then at UserPromptSubmit).
 */
import { segment, UNIT_MAX, UNIT_MIN, UNIT_SEG_MAX } from "./segment";
import { unitHash, type Scope } from "./registry";
import { claim, dequeue, enqueue, getSlot, isParked, known, queued, release, setSlot } from "./units";

/** Separator used to rejoin units (paragraph boundary, as produced by {@link segment}). */
const JOIN = "\n\n";

/**
 * Record `text` as delivered without emitting it (the caller already shows it
 * in full, e.g. an inline block recalled as is), so siblings and the loader
 * copy see its units as owned.
 * @param scope - Open registry scope.
 * @param text - The block that is being shown.
 * @param slotPrefix - Producer + event identity of `text`.
 */
export function markDelivered(scope: Scope, text: string, slotPrefix: string): void {
  segment(text).forEach((unit, i) => {
    const h = unitHash(unit);
    const slot = `${slotPrefix}:${i}`;
    const last = getSlot(scope, slot);
    if (last === h && known(scope, h)) return;
    if (last !== undefined && last !== h) { dequeue(scope, last); release(scope, h); }
    claim(scope, h);
    setSlot(scope, slot, h);
  });
}

/**
 * Take the next deliverable text for `scope`: previously parked units first
 * (arrival order), then the changed/unseen units of `text`. A unit that does
 * not fit the per-call cap — and every unit after it — is parked instead.
 * Throws when the registry cannot be written (the caller prints the original block).
 * @param scope - Open registry scope.
 * @param text - The block the hook wants to inject ("" to only drain the park).
 * @param now - Clock in ms (parking order).
 * @param slotPrefix - Producer + event identity of `text` (e.g. `rules:UserPromptSubmit`).
 * @param cap - Max chars returned by this call (default {@link UNIT_MAX}).
 * @param unitMax - Segmentation ceiling (default {@link UNIT_SEG_MAX}); a loader owner passes its share so every unit fits it.
 * @returns The text to emit now ("" when nothing new / nothing fits).
 */
export function deliverNext(scope: Scope, text: string, now: number, slotPrefix: string = "", cap: number = UNIT_MAX, unitMax: number = UNIT_SEG_MAX): string {
  const out: string[] = [];
  let used = 0;
  let full = false;
  const fits = (len: number): boolean => used + (out.length ? JOIN.length : 0) + len <= cap;
  const take = (unit: string): void => {
    out.push(unit);
    used += unit.length + (out.length > 1 ? JOIN.length : 0);
  };
  // The caller's OWN block comes first: what HEAD showed at this event must not be pushed out by another scope's parked units.
  segment(text, unitMax, Math.min(UNIT_MIN, Math.floor(unitMax / 2))).forEach((unit, i) => {
    const h = unitHash(unit);
    const slot = `${slotPrefix}:${i}`;
    const last = getSlot(scope, slot);
    const changed = last !== undefined && last !== h;
    // Unchanged slot and the unit is delivered/parked: nothing to do. (Unchanged but neither — e.g. a corrupt parked file was dropped — falls through and re-derives it.)
    if (last === h && known(scope, h)) return;
    if (changed) dequeue(scope, last);
    if (last === undefined ? known(scope, h) : changed && isParked(scope, h)) { setSlot(scope, slot, h); return; }
    if (changed) release(scope, h);
    if (full || !fits(unit.length)) {
      full = true;
      enqueue(scope, h, unit, now * 1000 + i);
    } else if (claim(scope, h)) take(unit);
    setSlot(scope, slot, h);
  });
  // Then the park, oldest first, with what is left of the budget.
  for (const q of queued(scope)) {
    if (q.t.length > cap) continue; // can never fit THIS caller's slice: leave it to a caller with room instead of blocking the line
    if (!fits(q.t.length)) break; // fits the slice but not what is left of it: keep order
    if (claim(scope, q.h)) take(q.t);
    dequeue(scope, q.h);
  }
  return out.join(JOIN);
}

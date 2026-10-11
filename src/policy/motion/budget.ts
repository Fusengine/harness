/**
 * @module motion/budget
 * Render counters per stage + accumulated wall time, in the harness-owned
 * store. A render is opened at PreToolUse (allowed) keyed by `tool_use_id`
 * and closed at PostToolUse, which counts it and adds its duration.
 * A reservation older than the TTL ({@link renderTtlMs}) stops blocking and
 * counting against caps, but is retained in `expired` until settled — a late
 * completion counts exactly like an unexpired render — or until the forget
 * horizon ({@link RENDER_FORGET_MS}) bounds reservations whose tool never ran.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { LOCK_FAILED } from "../../tracking/track-lock-sync";
import { withMotionProjectLock as withBudgetLock } from "./project-lock";
import type { Prompt } from "../../prompt/types";
import { readJsonObject } from "./store";
import type { MotionBudget, MotionRenderStart, MotionStage } from "../interfaces/motion";
import { isRecordObject as isObject, recordObject as obj } from "../../util/record-object";
import { budgetBlock, budgetPath, findReservation, MAX_MASTER_ENV, maxMasterRenders, num, partitionInflight, renderTtlMs, withMaps, writeBudget } from "./budget-store";

export { budgetLine, findReservation, MAX_MASTER_ENV, maxMasterRenders, RENDER_FORGET_MS, RENDER_TTL_ENV, renderTtlMs } from "./budget-store";

const STAGES: readonly string[] = ["stills", "draft", "master"];

/** True when every entry of a reservation map carries a known stage, a finite `ts` and optional string ids. */
function validStarts(value: unknown): boolean {
  return isObject(value) && Object.values(value).every((start) => isObject(start) && typeof start.stage === "string"
    && STAGES.includes(start.stage) && typeof start.ts === "number" && Number.isFinite(start.ts)
    && (start.sessionId === undefined || typeof start.sessionId === "string")
    && (start.agentId === undefined || typeof start.agentId === "string"));
}

/** Structural validation of a raw budget file; unknown top-level keys are ignored, an invalid `expired` is not. */
function validBudget(raw: Record<string, unknown>): boolean {
  if (!isObject(raw.renders) || !isObject(raw.wallMs) || !isObject(raw.inflight)) return false;
  if (raw.expired !== undefined && !validStarts(raw.expired)) return false;
  if (!Object.entries(raw.renders).every(([stage, n]) => STAGES.includes(stage) && typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return false;
  if (!Object.entries(raw.wallMs).every(([stage, n]) => STAGES.includes(stage) && typeof n === "number" && Number.isFinite(n) && n >= 0)) return false;
  return validStarts(raw.inflight);
}

/** Decode an already-read raw budget; the optional `expired` map is kept only when non-empty. */
function decodeBudget(raw: Record<string, unknown>): MotionBudget {
  const expired = obj(raw.expired) as NonNullable<MotionBudget["expired"]>;
  return {
    renders: obj(raw.renders) as MotionBudget["renders"],
    wallMs: obj(raw.wallMs) as MotionBudget["wallMs"],
    inflight: obj(raw.inflight) as MotionBudget["inflight"],
    ...(Object.keys(expired).length ? { expired } : {}),
  };
}

/** Load the budget (all-empty when missing/corrupt). */
export function loadBudget(root: string, home: string = homedir()): MotionBudget {
  return decodeBudget(readJsonObject(budgetPath(root, home)));
}

/** Reject a corrupt existing render budget rather than resetting its allowance. */
export function budgetViolation(root: string, home: string = homedir()): Prompt | null {
  const path = budgetPath(root, home);
  return existsSync(path) && !validBudget(readJsonObject(path)) ? budgetBlock("Motion budget is corrupt; the render allowance cannot be safely determined.") : null;
}

/**
 * Atomically reserve a render before allowing PreToolUse; masters count completed
 * renders plus FRESH in-flight reservations against their cap; TTL-expired entries
 * neither block nor count but stay settleable. Without an id, uncapped renders
 * remain a no-op, but capped masters cannot be safely admitted. An id already
 * reserved — fresh in-flight or retained expired — is refused (HEAD duplicate-id
 * semantics): an id never lives in both maps.
 * @param sessionId - Owning session, stored so SubagentStop can release it.
 * @param agentId - Owning sub-agent id (absent for the main turn), so a SubagentStop releases only the stopped sub-agent's calls.
 * @returns A block prompt on cap/lock failure, otherwise `null`.
 */
export function openRender(root: string, toolUseId: string | undefined, stage: MotionStage, now: number, home: string = homedir(), env: Record<string, string | undefined> = process.env, sessionId?: string, agentId?: string): Prompt | null {
  const cap = stage === "master" ? maxMasterRenders(env) : 0;
  if (!toolUseId) return budgetViolation(root, home) ?? (cap > 0 ? budgetBlock("A capped master render requires a tool_use_id for its reservation.") : null);
  const result = withBudgetLock(root, home, () => {
    const path = budgetPath(root, home), raw = readJsonObject(path);
    if (existsSync(path) && !validBudget(raw)) return budgetBlock("Motion budget is corrupt; the render allowance cannot be safely determined.");
    const b = decodeBudget(raw);
    const { inflight, expired, changed } = partitionInflight(b, now, renderTtlMs(env));
    const persist = (next: MotionBudget["inflight"]): void => writeBudget(path, withMaps(b, next, expired));
    if (Object.hasOwn(inflight, toolUseId) || Object.hasOwn(expired, toolUseId)) {
      if (changed) persist(inflight);
      return budgetBlock("This tool_use_id already has an in-flight render reservation; use a unique invocation id.");
    }
    const used = num(b.renders.master) + Object.values(inflight).filter((start) => start?.stage === "master").length;
    if (cap > 0 && used >= cap) {
      if (changed) persist(inflight);
      return budgetBlock(`Master render cap reached (${used}/${cap}, ${MAX_MASTER_ENV}; includes in-flight reservations).`);
    }
    const entry: MotionRenderStart = { stage, ts: now };
    if (sessionId !== undefined) entry.sessionId = sessionId;
    if (agentId !== undefined) entry.agentId = agentId;
    persist({ ...inflight, [toolUseId]: entry });
    return null;
  });
  return result === LOCK_FAILED ? budgetBlock("Motion budget lock busy; retry the render after the current update finishes.") : result;
}

/**
 * Close a render (PostToolUse): count it and add its wall time. The reservation
 * is found fresh in-flight first, then among TTL-expired retained entries, so a
 * late completion settles exactly like an unexpired one.
 * @param fallbackStage - Stage parsed from the command, used when no start was recorded.
 * @returns The updated budget.
 */
export function closeRender(root: string, toolUseId: string | undefined, fallbackStage: MotionStage, now: number, home: string = homedir()): MotionBudget {
  const result = withBudgetLock(root, home, () => {
    if (budgetViolation(root, home)) throw new Error("Motion budget is corrupt; completion was not recorded.");
    const b = loadBudget(root, home);
    const start = toolUseId ? findReservation(b, toolUseId) : undefined;
    const stage: MotionStage = start?.stage ?? fallbackStage;
    const inflight = { ...b.inflight };
    const expired = { ...(b.expired ?? {}) };
    if (toolUseId) {
      delete inflight[toolUseId];
      delete expired[toolUseId];
    }
    const elapsed = start ? Math.max(0, now - start.ts) : 0;
    const next: MotionBudget = {
      renders: { ...b.renders, [stage]: num(b.renders[stage]) + 1 },
      wallMs: { ...b.wallMs, [stage]: num(b.wallMs[stage]) + elapsed },
      inflight,
      ...(Object.keys(expired).length ? { expired } : {}),
    };
    writeBudget(budgetPath(root, home), next);
    return next;
  });
  if (result === LOCK_FAILED) throw new Error("Motion budget lock busy; completion was not recorded.");
  return result;
}

/** Release one matching failed/completed-inactive invocation without counting, fresh or expired; never infer inactivity from age. */
export function releaseRender(root: string, toolUseId: string | undefined, home: string = homedir()): MotionBudget {
  const result = withBudgetLock(root, home, () => {
    if (budgetViolation(root, home)) throw new Error("Motion budget is corrupt; reservation was not released.");
    const b = loadBudget(root, home);
    if (!toolUseId || !findReservation(b, toolUseId)) return b;
    const inflight = { ...b.inflight };
    const expired = { ...(b.expired ?? {}) };
    delete inflight[toolUseId];
    delete expired[toolUseId];
    const next: MotionBudget = { renders: b.renders, wallMs: b.wallMs, inflight, ...(Object.keys(expired).length ? { expired } : {}) };
    writeBudget(budgetPath(root, home), next);
    return next;
  });
  if (result === LOCK_FAILED) throw new Error("Motion budget lock busy; reservation was not released.");
  return result;
}

/**
 * Move TTL-expired reservations to the retained `expired` map (still settleable,
 * never blocking) and forget them past the horizon; persist when anything moved.
 * A corrupt budget fails closed: the file is never rewritten.
 * @returns The surviving fresh reservations, keyed by `tool_use_id`.
 */
export function pruneInflight(root: string, now: number, home: string = homedir(), env: Record<string, string | undefined> = process.env): MotionBudget["inflight"] {
  const result = withBudgetLock(root, home, () => {
    if (budgetViolation(root, home)) throw new Error("Motion budget is corrupt; stale reservations were not purged.");
    const b = loadBudget(root, home);
    const { inflight, expired, changed } = partitionInflight(b, now, renderTtlMs(env));
    if (changed) writeBudget(budgetPath(root, home), withMaps(b, inflight, expired));
    return inflight;
  });
  if (result === LOCK_FAILED) throw new Error("Motion budget lock busy; stale reservations were not purged.");
  return result;
}

/**
 * Release the FRESH in-flight reservations of ONE sub-agent (SubagentStop on
 * claude-code, where the payload's `agent_id` identifies the stopped
 * agent): only entries whose `sessionId` AND `agentId` match exactly are
 * released — on this host a PreToolUse carrying an `agent_id` is the only
 * way an entry gets one, so no other agent's (or the main turn's) reservation
 * can match, on any host version. TTL-expired retained entries are NEVER
 * touched: they no longer block and stay settleable for a late completion
 * (native-id entries) or until the 24 h horizon forgets them (`noid:`). The
 * main turn's Stop never triggers a release; a main-turn leak falls by the
 * TTL. Pre-0.1.104 entries carry no `sessionId` and expire by TTL only.
 */
export function releaseSessionRenders(root: string, sessionId: string, home: string = homedir(), agentId: string): MotionBudget {
  const result = withBudgetLock(root, home, () => {
    if (budgetViolation(root, home)) throw new Error("Motion budget is corrupt; session reservations were not released.");
    const b = loadBudget(root, home);
    const owned = (start: MotionRenderStart): boolean => start.sessionId === sessionId && start.agentId === agentId;
    const inflight = Object.fromEntries(Object.entries(b.inflight).filter(([, start]) => !owned(start)));
    if (Object.keys(inflight).length === Object.keys(b.inflight).length) return b;
    const next = withMaps(b, inflight, { ...(b.expired ?? {}) });
    writeBudget(budgetPath(root, home), next);
    return next;
  });
  if (result === LOCK_FAILED) throw new Error("Motion budget lock busy; session reservations were not released.");
  return result;
}

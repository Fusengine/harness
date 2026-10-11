/**
 * @module motion/budget-store
 * Pure budget helpers: file path and write (the `expired` map of TTL-expired
 * reservations retained for late settlement is omitted when empty, keeping the
 * 0.1.103-compatible shape), reservation-map lifecycle (fresh vs expired split,
 * forget horizon), env knobs and the human summary line.
 */
import { join } from "node:path";
import { parseEnvInt } from "../../config/env";
import type { Prompt } from "../../prompt/types";
import type { MotionBudget, MotionRenderStart, MotionStage } from "../interfaces/motion";
import { projectStoreDir, writeJsonObject } from "./store";

/** Env var capping master renders (unset/invalid = no cap). */
export const MAX_MASTER_ENV = "FUSE_MOTION_MAX_MASTER_RENDERS";

/** Env var overriding the in-flight reservation TTL in ms (unset/invalid = 30 min). */
export const RENDER_TTL_ENV = "FUSE_MOTION_RENDER_TTL_MS";

const DEFAULT_RENDER_TTL_MS = 30 * 60 * 1000;

/**
 * Horizon past which an expired reservation is forgotten entirely (24 h from its
 * start): bounds entries whose tool never ran, while staying far beyond any real
 * render duration so genuine late completions still settle.
 */
export const RENDER_FORGET_MS: number = 24 * 60 * 60 * 1000;

/** Absolute path of the per-project render budget file. */
export const budgetPath = (root: string, home: string): string => join(projectStoreDir(root, home), "budget.json");

/** Block prompt factory shared by the budget guards. */
export const budgetBlock = (reason: string): Prompt => ({ kind: "block", ruleId: "motion-budget", title: "Motion render budget", reason });

/** Numeric budget field, or 0 when absent/invalid. */
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A reservation older than the TTL no longer blocks or counts; a future `ts` never expires. */
const stale = (start: { ts: number }, now: number, ttl: number): boolean => now - start.ts > ttl;

/** Reservation maps produced by {@link partitionInflight}. */
interface InflightPartition {
  inflight: MotionBudget["inflight"];
  expired: NonNullable<MotionBudget["expired"]>;
  changed: boolean;
}

/**
 * Split the budget reservations: fresh in-flight (still blocking and counted),
 * TTL-expired retained for settlement, forgotten past {@link RENDER_FORGET_MS}.
 * @returns The fresh map, the retained expired map, and whether anything moved.
 */
export function partitionInflight(b: MotionBudget, now: number, ttl: number): InflightPartition {
  const partition: InflightPartition = { inflight: {}, expired: {}, changed: false };
  for (const [id, start] of Object.entries(b.inflight)) (stale(start, now, ttl) ? partition.expired : partition.inflight)[id] = start;
  for (const [id, start] of Object.entries(b.expired ?? {})) if (!Object.hasOwn(partition.expired, id)) partition.expired[id] = start;
  for (const id of Object.keys(partition.expired)) if (now - partition.expired[id]!.ts > RENDER_FORGET_MS) delete partition.expired[id];
  partition.changed = Object.keys(partition.inflight).length !== Object.keys(b.inflight).length
    || Object.keys(partition.expired).length !== Object.keys(b.expired ?? {}).length;
  return partition;
}

/** The reservation a terminal callback settles: fresh in-flight first, else the TTL-expired one retained for late settlement. */
export function findReservation(b: MotionBudget, toolUseId: string): MotionRenderStart | undefined {
  return b.inflight[toolUseId] ?? b.expired?.[toolUseId];
}

/** Budget with the given reservation maps, dropping `expired` when empty. */
export function withMaps(b: MotionBudget, inflight: MotionBudget["inflight"], expired: NonNullable<MotionBudget["expired"]>): MotionBudget {
  return { renders: b.renders, wallMs: b.wallMs, inflight, ...(Object.keys(expired).length ? { expired } : {}) };
}

/** Persist a budget, omitting an empty `expired` map (0.1.103-compatible file shape). */
export function writeBudget(path: string, b: MotionBudget): void {
  writeJsonObject(path, { renders: b.renders, wallMs: b.wallMs, inflight: b.inflight, ...(b.expired && Object.keys(b.expired).length ? { expired: b.expired } : {}) });
}

/** The master-render cap from {@link MAX_MASTER_ENV} (0 = no cap). */
export function maxMasterRenders(env: Record<string, string | undefined> = process.env): number {
  return parseEnvInt(env[MAX_MASTER_ENV], 0);
}

/** The in-flight reservation TTL in ms from {@link RENDER_TTL_ENV} (default 30 min). */
export function renderTtlMs(env: Record<string, string | undefined> = process.env): number {
  return parseEnvInt(env[RENDER_TTL_ENV], DEFAULT_RENDER_TTL_MS);
}

/** One-line human summary, e.g. `renders stills 2 · draft 1 · master 0 — wall 3m12s`. */
export function budgetLine(b: MotionBudget, env: Record<string, string | undefined> = process.env): string {
  const n = (s: MotionStage): number => num(b.renders[s]);
  const ms = Object.values(b.wallMs).reduce<number>((a, v) => a + num(v), 0);
  const cap = maxMasterRenders(env);
  const wall = `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`;
  return `Motion budget: renders stills ${n("stills")} · draft ${n("draft")} · master ${n("master")}${cap ? `/${cap}` : ""} — wall ${wall}`;
}

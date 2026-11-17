/**
 * @module deny-loop-store
 * Sidecar state + gate wiring for the mechanical anti-loop ({@link module:deny-loop}).
 *
 * STATE — a standalone sidecar (`deny-loop.json`) in the same per-project state
 * dir as the session track, NOT a field in `session-state.ts`: that file is owned
 * by another concern this batch, so a shared field would couple two owners and
 * contend on one file for two unrelated maps. This mirrors the proven
 * {@link module:inject-dedup} `oncePerWindow` sidecar (atomicWrite, prune-by-window,
 * fail-open) and keeps the anti-loop self-contained.
 *
 * WINDOW — the hash expires with the same freshness window the gate already uses
 * (`FUSE_ENFORCE_TTL_SEC` / `windowMs`): a loop is a burst, not a lifetime, so a
 * stale deny past the window resets and a later identical call is a fresh #1.
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../util/json-io";
import { denyHash, denyLoopCheck, enrichRepeatDeny, type DenyEntry, type DenyLoopResult } from "../policy/deny-loop";
import { BURST_DEDUP_MS } from "./burst-window";
import type { Prompt } from "../prompt/types";

/** Sidecar basename under the per-project state dir. */
const SIDECAR = "deny-loop.json";

/**
 * Injected clock + state dir + expiry window (no env var; the gate supplies all
 * three). `sessionId` — when present — scopes the map key AND arms the burst
 * dedup ({@link module:burst-window}) so the ~11 sibling plugin hooks of ONE
 * event count once, not once each; two sessions never share a counter. Omitted
 * by mono-process callers/tests → historical per-hash, no-dedup behaviour.
 */
export interface DenyLoopOpts { now: number; dir: string; windowMs: number; sessionId?: string; /** Running host id: names the research agent in a repeat-deny action (default Claude Code). */ hostId?: string; }

/** Load the `{ hash -> DenyEntry }` map, or `{}` when missing/corrupt. */
function loadMap(path: string): Record<string, DenyEntry> {
  try {
    if (!existsSync(path)) return {};
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, DenyEntry>) : {};
  } catch {
    return {};
  }
}

/** Drop entries whose last deny is older than the window (bounds size + resets stale loops). */
function prune(map: Record<string, DenyEntry>, now: number, windowMs: number): Record<string, DenyEntry> {
  const out: Record<string, DenyEntry> = {};
  for (const [k, e] of Object.entries(map)) {
    if (e && typeof e.lastTs === "number" && now - e.lastTs < windowMs) out[k] = e;
  }
  return out;
}

/**
 * Record a deny for `(tool, input)`: prune, {@link denyLoopCheck}, persist the
 * bumped entry. Fails open (`isRepeat:false`) when the sidecar is unwritable — a
 * broken state dir must never manufacture a false `[REPEAT]`.
 * @param tool - Tool name.
 * @param input - Identifying tool input.
 * @param opts - Clock + state dir + window.
 * @returns `{ isRepeat, count, hash }`.
 */
export function recordDeny(tool: string, input: Record<string, unknown>, opts: DenyLoopOpts): DenyLoopResult {
  const hash = denyHash(tool, input);
  const sid = opts.sessionId?.trim();
  const key = sid ? `${hash}::${sid}` : hash;
  const path = join(opts.dir, SIDECAR);
  const map = prune(loadMap(path), opts.now, opts.windowMs);
  const res = denyLoopCheck(key, map, { now: opts.now, windowMs: opts.windowMs, dedupMs: sid ? BURST_DEDUP_MS : 0 });
  if (!res.deduped) {
    map[key] = { count: res.count, lastTs: opts.now };
    try { atomicWrite(path, JSON.stringify(map)); } catch { /* fail-open: never fabricate a repeat */ }
  }
  return { ...res, hash };
}

/**
 * Gate tail: record every block deny; on a repeat, return the enriched prompt.
 * Allows (`null`) and non-block prompts (`ask`/`inform`) pass through untouched —
 * a loop is a retried REFUSAL, and only `block` is a refusal. The decision is
 * NEVER changed; only a repeated block's message is rewritten.
 * @param prompt - The gate's outcome.
 * @param tool - Tool name.
 * @param input - Identifying tool input.
 * @param opts - Clock + state dir + window.
 * @returns The prompt, enriched only when it is a repeated block.
 */
export function withDenyLoop(prompt: Prompt | null, tool: string, input: Record<string, unknown>, opts: DenyLoopOpts): Prompt | null {
  if (!prompt || prompt.kind !== "block") return prompt;
  const { isRepeat, count } = recordDeny(tool, input, opts);
  return isRepeat ? enrichRepeatDeny(prompt, count, opts.hostId) : prompt;
}

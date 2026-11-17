/**
 * @module deny-loop
 * Pure anti-loop logic: hash a tool-call, decide if it repeats a prior deny, and
 * enrich the repeated block's message.
 *
 * The proprietary rule "NEVER propose the same fix twice" is prose a model under
 * pressure ignores. This makes it machine-enforced: when a call whose
 * `(tool + normalized input)` hash was ALREADY denied in-window is retried, the
 * harness keeps the deny but rewrites the message — `[REPEAT]` title, a
 * mid-sentence STOP warning, forced `research-expert` action. State + wiring live in the sidecar
 * store ({@link module:deny-loop-store}); this file is IO-free and pure.
 * @packageDocumentation
 */
import { hashText } from "../util/json-io";
import type { Prompt } from "../prompt/types";
import { hostAgentRef } from "./apex-target";

/** One recorded deny: identical-in-window count, and when the last landed. */
export interface DenyEntry { count: number; lastTs: number; }

/** Loop-check outcome: does the input repeat an in-window deny, and its running count. */
export interface DenyLoopResult { isRepeat: boolean; count: number; hash: string; deduped?: boolean; }

/** Stable JSON: keys sorted at every depth so `{a,b}` and `{b,a}` hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/**
 * Stable identity hash of a tool-call = tool name + normalized (key-sorted) input,
 * so re-ordered keys never mask a repeat.
 * @param tool - Tool name (e.g. "Write", "Bash").
 * @param input - Identifying tool input (filePath/content/command...).
 * @returns 8-char hex hash.
 */
export function denyHash(tool: string, input: Record<string, unknown>): string {
  return hashText(`${tool}\n${stableStringify(input)}`);
}

/**
 * Pure loop check: given the already-pruned in-window map, compute the running
 * count for `hash` and whether it repeats (count > 1). No IO — the caller persists.
 *
 * When `dedupMs` is set (>0) and an identical prior deny landed within that
 * window, the current call is a sibling hook echoing the SAME event (see
 * {@link module:burst-window}): it returns the prior verdict VERBATIM with
 * `deduped:true` and does NOT bump the count, so all N fan-out processes agree
 * on one number instead of counting to N. Absent `dedupMs` (mono-process
 * callers / unit tests) the historical increment-every-time behaviour holds.
 * @param hash - {@link denyHash}-derived map key of the current call.
 * @param priorDenies - The `{ hash -> DenyEntry }` map, pruned to `now`/`windowMs`.
 * @param opts - Clock + window, plus an optional burst-dedup window.
 * @returns `{ isRepeat, count, hash, deduped? }`.
 */
export function denyLoopCheck(hash: string, priorDenies: Record<string, DenyEntry>, opts: { now: number; windowMs: number; dedupMs?: number }): DenyLoopResult {
  const prev = priorDenies[hash];
  const fresh = prev && typeof prev.lastTs === "number" && opts.now - prev.lastTs < opts.windowMs;
  if (!fresh) return { isRepeat: false, count: 1, hash };
  if ((opts.dedupMs ?? 0) > 0 && opts.now - prev.lastTs < (opts.dedupMs ?? 0)) {
    return { isRepeat: prev.count > 1, count: prev.count, hash, deduped: true };
  }
  const count = prev.count + 1;
  return { isRepeat: count > 1, count, hash };
}

/**
 * Enrich a REPEATED block prompt — a NEW object, never a mutation (the input may
 * be a shared const like FAIL_CLOSED). The decision stays `block`; only the
 * message changes, so every harness renders it through the same adapter.
 * @param prompt - The original block prompt.
 * @param count - The running identical-deny count (n).
 * @param hostId - Running host id: names the research agent as that host does (default Claude Code, text unchanged).
 * @returns A block prompt with `[REPEAT]` title, STOP-prefixed reason, forced research action.
 */
export function enrichRepeatDeny(prompt: Prompt, count: number, hostId: string = "claude-code"): Prompt {
  // H2b: the counter cannot know whether new reads/actions happened since the
  // last deny, so the hard STOP is reserved for the UNCHANGED retry — a retry
  // after completing the required reads/actions is legitimate and expected.
  const stop = `Identical attempt #${count} already denied for the same reason. Do not retry this same call UNCHANGED — if you have since completed the required reads/actions, retry now; otherwise STOP and pick a DIFFERENT approach. `;
  const action = `Launch ${hostAgentRef(hostId, "research-expert")} to find a DIFFERENT approach`;
  return {
    ...prompt,
    title: prompt.title.startsWith("[REPEAT]") ? prompt.title : `[REPEAT] ${prompt.title}`,
    reason: stop + prompt.reason,
    actions: [action, ...(prompt.actions ?? [])],
  };
}

/**
 * @module inject-session/filter
 * Claude Code ONLY: the single output filter that makes every injected context
 * block reach the model once per session instead of once per hook event.
 *
 * - SessionStart / UserPromptSubmit / SubagentStart: the `additionalContext` is
 *   reduced to the units not yet delivered in this session (or sub-agent), at
 *   most {@link UNIT_MAX} chars; the overflow is parked and delivered by later
 *   events. A SessionStart starts a new epoch (startup/clear/compact/fork), so a
 *   rebuilt context is refilled in full.
 * - PostToolUse: only parked units are appended (this is how a sub-agent, which
 *   gets a single SubagentStart, receives the rest of a block larger than the
 *   cap). Never PreToolUse: a sibling deny would swallow what was claimed there.
 *   Decisions (deny/ask/block) are never touched.
 * - The hooks-loader copy of a hook ({@link module:inject-session/loader-child})
 *   never claims, parks, drains or bumps an epoch: its output is merged with
 *   every other plugin's into one string that can exceed the 10 000-char cap.
 *   It prints exactly what HEAD printed, minus units the native copy already owns.
 * Producers and their content are untouched; every other host never reaches here.
 */
import { sanitizeSessionId } from "../home-state";
import { contextResponse } from "../../adapters/claude";
import { deliverNext, markDelivered } from "./deliver";
import { claimRecall, dedupeUnits, promptIdOf, recalledFor, SPILL_AT, trimOverlap, visibleHead } from "./recall";
import { openScope, peekScope, scopeName, unitHash } from "./registry";
import { hasParked, known } from "./units";
import { segment, UNIT_MAX } from "./segment";
import { stripNativeDoc } from "./native-doc";
import { contextOf, isDecision, parseEnvelope, withContext } from "./envelope";
import { ownerDrain, ownerPrompt, ownerStart } from "./owner";
import { nativeHead, recordOriginal } from "./native-head";
import type { Ownership } from "./ownership";

/** Events whose `additionalContext` is deduplicated. */
const INJECT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);
/** Events that only drain parked units. */
const DRAIN_EVENTS = new Set(["PostToolUse"]);

/** Inputs of {@link filterClaudeContext}. */
export interface FilterInput {
  /** Raw hook payload. */
  payload: Record<string, unknown>;
  /** Per-project harness state dir (`~/.fuse-harness/state/<hash>`). */
  stateDir: string;
  /** Home dir (native CLAUDE.md lookup). */
  home: string;
  /** Clock in ms. */
  now: number;
  /** Plugin scope of the calling hook process (distinguishes sibling SessionStart processes from a repeated SessionStart). */
  scope: string;
  /** Is this process the hooks-loader's duplicate copy? (default: no) */
  isLoaderChild?: () => boolean;
  /** Does this scope+event have NO native copy (owner) and how many scopes share the loader's merged field? (default: never owner) */
  ownership?: (event: string, scope: string, tool?: string) => Ownership;
  /** The hooks-loader's merge order of plugin scopes for an event (`agentType` selects the matching registrations); [] when unknown. */
  order?: (event: string, agentType: string) => string[];
  /** Max ms a native-backed loader child waits for the scopes before it to record their block length (default 0). */
  settleMs?: number;
}

/**
 * UserPromptSubmit: RECALL on every prompt what HEAD showed (inline block as is, or the 2 000-char
 * head of a spilled one — {@link module:inject-session/recall}), deduplicated only for true
 * duplicates, plus the not-yet-delivered chunks of a spilled block within the 9 500-char budget.
 * The CLAUDE.md body is NOT stripped here: its per-prompt repetition is the feature.
 */
function recallPrompt(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput): string {
  const original = contextOf(obj);
  if (!original) return stdout;
  const scope = openScope(input.stateDir, name);
  const text = dedupeUnits(original);
  const slot = `${input.scope}:${event}`;
  if (!claimRecall(scope, text, promptIdOf(input.payload))) return withContext(obj, event, "");
  if (text.length <= SPILL_AT) {
    markDelivered(scope, text, slot);
    // Units parked at SessionStart/SubagentStart ride along while the inline block leaves room.
    const parked = hasParked(input.stateDir, name) ? deliverNext(scope, "", input.now, slot, UNIT_MAX - text.length - 2) : "";
    if (parked) return withContext(obj, event, `${text}\n\n${parked}`);
    return text === original ? stdout : withContext(obj, event, text);
  }
  const head = visibleHead(text);
  const rest = deliverNext(scope, text, input.now, slot, UNIT_MAX - head.length - 2);
  return withContext(obj, event, trimOverlap(head, rest));
}

/** Inject-event path: dedup + cap the block, then rebuild the envelope. */
function filterInject(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput): string {
  if (event === "UserPromptSubmit") return recallPrompt(stdout, obj, event, name, input);
  const reset = event === "SessionStart" ? { source: String(input.payload.source ?? "startup"), scope: input.scope } : undefined;
  const scope = openScope(input.stateDir, name, reset);
  const original = contextOf(obj);
  const kept = deliverNext(scope, stripNativeDoc(original, input.home), input.now, `${input.scope}:${event}`);
  return kept === original ? stdout : withContext(obj, event, kept);
}

/** Loader-copy path: read-only; drop only the units the native copy already delivered or parked. */
function filterLoaderCopy(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput): string {
  const original = contextOf(obj);
  const scope = peekScope(input.stateDir, name);
  if (event === "UserPromptSubmit") {
    // Per-prompt recall: silent ONLY if the native copy recalled this very block for THIS prompt_id; otherwise print exactly what HEAD printed.
    return scope && recalledFor(scope, dedupeUnits(original), promptIdOf(input.payload)) ? withContext(obj, event, "") : stdout;
  }
  const text = stripNativeDoc(original, input.home);
  const units = segment(text);
  const fresh = scope ? units.filter((u) => !known(scope, unitHash(u))) : units;
  if (text === original && fresh.length === units.length) return stdout;
  return withContext(obj, event, fresh.join("\n\n"));
}

/** Tool-event path: append parked units only, never touching the tool's own output. */
function filterDrain(stdout: string, obj: Record<string, unknown>, event: string, name: string, input: FilterInput): string {
  if (!hasParked(input.stateDir, name)) return stdout;
  const kept = deliverNext(openScope(input.stateDir, name), "", input.now);
  if (!kept) return stdout;
  const own = contextOf(obj);
  return Object.keys(obj).length ? withContext(obj, event, own ? `${own}\n\n${kept}` : kept) : contextResponse(event, kept);
}

/**
 * Filter one Claude Code hook stdout through the per-session registry.
 * Fails open: any registry error returns `stdout` unchanged (the full original block, like HEAD).
 * @param stdout - The stdout the hook handler produced.
 * @param input - Payload, state dir, home, clock, plugin scope and loader-copy probe.
 * @returns The stdout to print (unchanged for any event/shape this filter does not own).
 */
export function filterClaudeContext(stdout: string, input: FilterInput): string {
  const event = typeof input.payload.hook_event_name === "string" ? input.payload.hook_event_name : "";
  const inject = INJECT_EVENTS.has(event);
  if (!inject && !DRAIN_EVENTS.has(event)) return stdout;
  const sid = sanitizeSessionId(input.payload.session_id);
  const agent = sanitizeSessionId(input.payload.agent_id);
  if (!sid || (event === "SubagentStart" && !agent)) return stdout;
  const obj = parseEnvelope(stdout);
  if (obj === null || isDecision(obj)) return stdout;
  const name = scopeName(sid, agent);
  try {
    // Drain-only events with nothing parked: nothing to do, and no need to pay for the loader probe (ps).
    if (!inject && !hasParked(input.stateDir, name)) return stdout;
    // SubagentStart: every process of the recipient notes its original block length — the offsets of 0.1.107's merged preview ({@link module:inject-session/native-head}).
    if (event === "SubagentStart") recordOriginal(openScope(input.stateDir, name), event, input.scope, contextOf(obj).length);
    if (input.isLoaderChild?.()) {
      // No native copy for this scope+event (its plugin is not enabled): the loader copy is THE owner, within the shared merged-field budget.
      const tool = typeof input.payload.tool_name === "string" ? input.payload.tool_name : undefined;
      const own = input.ownership?.(event, input.scope, tool);
      if (own?.owner) {
        if (!inject) return ownerDrain(stdout, obj, event, name, input, own.owners);
        return event === "UserPromptSubmit" ? ownerPrompt(stdout, obj, event, name, input, own.owners) : ownerStart(stdout, obj, event, name, input, own.owners);
      }
      // A native copy provably runs for this scope+event: the loader's duplicate prints NOTHING. Whatever it printed would be added to the
      // merged field on top of the owners' budget (and, if it ran before the native copy recorded anything, it could push that field past 10 000).
      if (own?.native) return inject ? nativeHead(stdout, obj, event, name, input) : stdout;
      return inject ? filterLoaderCopy(stdout, obj, event, name, input) : stdout;
    }
    return inject ? filterInject(stdout, obj, event, name, input) : filterDrain(stdout, obj, event, name, input);
  } catch {
    return stdout;
  }
}

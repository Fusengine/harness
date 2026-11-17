import { formatDocDeny, isDocConsulted, type AuthEntry } from "../freshness/doc-helpers";
import type { RefMeta } from "../refs/types";
import type { Prompt } from "../prompt/types";

/**
 * Session context for the stateful APEX gates. The harness adapter supplies this
 * (the package owns the gate LOGIC; recording the session activity is the
 * adapter's tracking layer).
 */
export interface ApexContext {
  /** Running host id: a non-Claude host is never shown a `~/.claude` skill path in gate messages (absent = Claude Code). */
  hostId?: string;
  sessionId: string;
  framework: string;
  filePath: string;
  content: string;
  /** Doc-consultation authorizations from session state (Context7/Exa). */
  authorizations?: Record<string, AuthEntry>;
  /** Available SOLID references for the framework's skill. */
  refs?: RefMeta[];
  /** Absolute paths of SOLID refs already read this session. */
  refsRead?: string[];
  /**
   * Epoch-ms read timestamp per `refsRead` path (parity track-solid-reads.py
   * `solid_reads[].timestamp`). PARITY: the TTL applies ONLY to solidReadGate —
   * Python TTL-izes SOLID reads exclusively (require-solid-read.py); the
   * skill-trigger/design/shadcn gates stay session-scoped (no TTL). A path in
   * `refsRead` with no stamp here (tracks recorded before this field existed)
   * counts as read — backward compat.
   */
  refsReadAt?: Record<string, number>;
  /** Current epoch ms for the SOLID-read TTL check; absent → reads never expire. */
  now?: number;
  /** Whether the required prior agents (explore + research) ran within the freshness window. */
  agentsFresh?: boolean;
  /** Names of REQUIRED_AGENTS that have NOT run fresh (subset), for a precise freshnessGate message. Absent → generic wording. */
  missingAgents?: string[];
  /** Freshness window in ms: labels the block messages' TTL (e.g. "2min") and bounds the SOLID-read TTL in solidReadGate. */
  windowMs?: number;
  /** Whether brainstorming is required for this edit (creation intent on a new file). */
  brainstormRequired?: boolean;
  /** Whether the brainstorming agent ran within the window. */
  brainstormFresh?: boolean;
}

/** A single APEX gate: returns a blocking {@link Prompt}, or null to pass. */
export type ApexGate = (ctx: ApexContext) => Prompt | null;

/** Gate: BOTH Context7 AND Exa (or a web fallback alone) must have been consulted this session. */
export const docConsultedGate: ApexGate = (ctx) =>
  isDocConsulted(ctx.authorizations, ctx.sessionId)
    ? null
    : {
        kind: "block",
        title: "APEX: documentation not consulted",
        reason: formatDocDeny(ctx.framework),
        actions: ["Use BOTH mcp__context7__query-docs AND mcp__exa__web_search_exa, or a web fallback alone (WebSearch/WebFetch)"],
      };

/** Gate: brainstorming must precede creating new files when flagged. */
export const brainstormGate: ApexGate = (ctx) =>
  ctx.brainstormRequired && ctx.brainstormFresh === false
    ? {
        kind: "block",
        title: "APEX: brainstorm first",
        reason: `Creation intent detected — brainstorm before creating new ${ctx.framework} files.`,
        actions: ["Launch the brainstorming agent"],
      }
    : null;

// solidReadGate/freshnessGate live in ./apex-gates (kept out of this file for
// the SOLID file-size ceiling — they import ApexContext/ApexGate from here).
export { solidReadGate, freshnessGate } from "./apex-gates";
import { solidReadGate, freshnessGate } from "./apex-gates";

/** Gates that run BEFORE Check 1 (harness-specific brainstorm + agent freshness, pre-dating enforce-apex-phases). */
export const PRE_AUTH_GATES: ReadonlyArray<ApexGate> = [brainstormGate, freshnessGate];

/** Gates that run AFTER Check 1: Check 2 (doc consulted once per session) then the SOLID refs. */
export const POST_AUTH_GATES: ReadonlyArray<ApexGate> = [docConsultedGate, solidReadGate];

/**
 * Default APEX gate chain (brainstorm, freshness, docs, SOLID refs). Check 1
 * (`apexAuthorizationGate`, policy/apex-authorization.ts) is wired BETWEEN the
 * PRE and POST sub-chains by the runtime (gate-apex.ts), which owns its
 * target-write side effect — parity enforce-apex-phases.ts Check1 -> Check2.
 */
export const APEX_GATES: ReadonlyArray<ApexGate> = [...PRE_AUTH_GATES, ...POST_AUTH_GATES];

/**
 * Run the APEX gates (chain-of-responsibility): the first failing gate's prompt
 * wins; null means every gate passed (allow).
 */
export function evaluateApex(ctx: ApexContext, gates: ReadonlyArray<ApexGate> = APEX_GATES): Prompt | null {
  return gates.reduce<Prompt | null>((hit, gate) => hit ?? gate(ctx), null);
}

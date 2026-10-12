import { evaluateApex, PRE_AUTH_GATES, POST_AUTH_GATES, type ApexContext } from "../policy/apex";
import { apexAuthorizationGate } from "../policy/apex-authorization";
import { listAllMissing } from "../policy/apex-missing";
import { isTrivialEdit, protectedPathGate, SKIP_DIRS } from "../policy/trivial-edits";
import { FAIL_CLOSED } from "../policy/guards";
import { agentsFresh, recordTarget, recordTrivialEdit, trivialCount, type SessionTrack } from "../tracking/session-state";
import { agentsRanFromTranscript } from "../freshness/agent-evidence";
import { agentsFreshInTrack } from "../freshness/agent-evidence-record";
import { withTrack } from "../tracking/store";
import { exclusiveHeld, onceExclusive } from "./inject-dedup-exclusive";
import { dirname, join } from "node:path";
import { REQUIRED_AGENTS, TRIVIAL_BUDGET } from "./gate";
import type { GateInput } from "./gate-input";
import type { Prompt } from "../prompt/types";

/**
 * Whether this trivial edit charges the budget: always, except a Codex
 * `apply_patch` sibling whose `trivialClaimKey` another sibling already claimed
 * (exclusive marker per key, its own sub-dir so other callers' sweeps keep it).
 * @param input - The tool-use being gated.
 * @param window - Freshness window in ms (marker lifetime).
 */
function chargesTrivialBudget(input: GateInput, window: number): boolean {
  if (!input.trivialClaimKey) return true;
  return onceExclusive(input.trivialClaimKey, window, { now: input.now, dir: trivialClaimDir(input) });
}

/**
 * Codex sibling of a trivial edit another sibling of the SAME tool call already
 * charged: it is that same edit, so it stays trivial even if the budget is now
 * full (the charging sibling's write must not flip its siblings to a deny).
 * @param input - The tool-use being gated.
 * @param window - Freshness window in ms (claim lifetime).
 */
function siblingAlreadyCharged(input: GateInput, window: number): boolean {
  return !!input.trivialClaimKey && exclusiveHeld(input.trivialClaimKey, window, { now: input.now, dir: trivialClaimDir(input) });
}

/**
 * Timestamp recorded for a trivial charge. The log keeps timestamps by value (equal
 * values collapse into one charge) and Codex siblings each read their own integer
 * clock, so a patch entry adds `slot / 4096` ms — exact in a double at today's epoch
 * (spacing 2^-12 below 2^41 ms): two entries of one patch (index < 4096) never share a
 * stamp, even charged by different siblings, keyed or not. Non-patch charges (every
 * non-Codex Edit: no `trivialSlot`) keep the plain `now`.
 * @param input - The tool-use being gated.
 */
function trivialStamp(input: GateInput): number {
  if (input.trivialSlot === undefined) return input.now;
  return input.now + (input.trivialSlot % 4096) / 4096;
}

/** Claim markers live in their own sub-dir so other callers' sweeps never drop them. */
function trivialClaimDir(input: GateInput): string {
  return join(dirname(input.trackFile), "apex-trivial");
}

/**
 * The APEX-scoped portion of {@link gate}, in the Python enforce-apex-phases.ts
 * order: protected-paths guard, skip-dirs allow, trivial-edit fast path, then
 * brainstorm/freshness, Check 1 (per-framework doc authorization — a deny
 * persists `track.target` so recordDoc can cross-credit the framework) and
 * Check 2 + SOLID refs. Freshness scans the SESSION track first (parity
 * _scan_agents: sub-agent hooks share the lead's session_id, so sidechain/
 * Workflow research is visible); the platform-authored transcript scan and the
 * legacy exact-name track check are fallbacks.
 * @param input - The tool-use to gate.
 * @param track - The loaded session track.
 * @param window - Freshness window in ms.
 * @returns The first blocking prompt, or null to fall through to the DRY check.
 */
export async function apexScopedGate(input: GateInput, track: SessionTrack, window: number): Promise<Prompt | null> {
  // (1) Hook-managed paths: absolute deny BEFORE any other filter (parity :49-52).
  const protectedDeny = protectedPathGate(input.tool, input.filePath);
  if (protectedDeny) return protectedDeny;
  // (2) CODE_EXT runs upstream (gate.ts isApexScoped); dependency/build dirs skip (parity :53-54).
  if (SKIP_DIRS.test(input.filePath ?? "")) return null;

  // (3) Trivial-edit fast path: a few tiny, non-replace Edits skip the APEX gates
  // (parity :58-65 — only Edit ever qualifies as "trivial"; a Write always
  // creates/replaces a file wholesale and must go through the full gate).
  if (isTrivialEdit(input.tool, input.content, input.isReplaceAll)) {
    if (siblingAlreadyCharged(input, window)) return null;
    if (trivialCount(track, window, input.now) < TRIVIAL_BUDGET) {
      if (chargesTrivialBudget(input, window)) await withTrack(input.trackFile, (fresh) => recordTrivialEdit(fresh, trivialStamp(input), window, input.now));
      return null;
    }
  }

  const freshnessFor = (names: string[], windowMs: number = window): boolean =>
    agentsFreshInTrack(track, names, windowMs, input.now) ||
    (input.transcriptPath ? agentsRanFromTranscript(input.transcriptPath, names, windowMs, input.now, dirname(input.trackFile)) : agentsFresh(track, names, windowMs, input.now));

  const ctx: ApexContext = {
    sessionId: input.sessionId,
    framework: input.framework,
    filePath: input.filePath ?? "",
    content: input.content ?? "",
    authorizations: track.authorizations,
    refs: input.refs, // lazily completed from input.loadRefs below
    refsRead: track.refsRead,
    refsReadAt: track.refsReadAt, // SOLID-read TTL stamps (absent → no expiry)
    now: input.now,
    agentsFresh: freshnessFor([...REQUIRED_AGENTS]),
    missingAgents: REQUIRED_AGENTS.filter((name) => !freshnessFor([name])),
    windowMs: window,
    // Parity require-apex-agents.py:41 — Edit never creates a file (skip brainstorm),
    // and a subagent (agent_id present) inherits the lead's brainstorm decision, so
    // only a lead Write is ever brainstorm-gated.
    brainstormRequired: input.tool === "Edit" || input.agentId ? false : track.brainstormRequired,
    brainstormFresh: freshnessFor(["brainstorming"], Number.MAX_SAFE_INTEGER),
  };
  try {
    // (4) Brainstorm + explore/research freshness (pre-existing harness gates; neither reads refs).
    const pre = evaluateApex(ctx, PRE_AUTH_GATES);
    // The refs stay unloaded on a PRE block (lazy contract, src/refs/lazy.ts): only the ref-free gates are listed alongside it. Nothing is written.
    if (pre) return listAllMissing(pre, ctx, false);
  } catch {
    return FAIL_CLOSED;
  }
  // Lazy refs (see lazyRefs): first consumed by Check 1 / the SOLID gate below, so loaded only once the PRE gates pass — outside the FAIL_CLOSED try on purpose, a throw from an unreadable refs dir propagates as handle-pre's former eager load did.
  ctx.refs = input.refs ?? (await input.loadRefs?.());
  try {
    // (5) Check 1 — a deny persists `target` (parity :80-81) for recordDoc's cross-credit.
    const authDeny = apexAuthorizationGate(ctx);
    if (authDeny) {
      const set_at = new Date(input.now).toISOString();
      await withTrack(input.trackFile, (fresh) => recordTarget(fresh, { project: input.cwd ?? "", framework: input.framework, set_by: "apex-authorization", set_at }));
      return listAllMissing(authDeny, ctx, true);
    }
    // (6) Check 2 (doc consulted once per session) + SOLID refs.
    const post = evaluateApex(ctx, POST_AUTH_GATES);
    return post && listAllMissing(post, ctx, true);
  } catch {
    return FAIL_CLOSED;
  }
}

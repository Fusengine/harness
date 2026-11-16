import type { AuthEntry } from "../freshness/doc-helpers";
import { creditDocConsultation, type SessionTarget } from "../policy/apex-authorization";
import type { Receipt } from "./receipts";

/** Quality of a recorded agent call (the freshness gate ignores insufficient ones). */
export type AgentQuality = "sufficient" | "insufficient";

/** Recorded session activity that feeds the APEX gates. */
export interface SessionTrack {
  authorizations: Record<string, AuthEntry>;
  refsRead: string[];
  /**
   * Epoch-ms timestamp of each reference read, keyed by `refsRead` path (parity
   * track-solid-reads.py `solid_reads[].timestamp`). Optional: tracks persisted
   * before this field existed only carry `refsRead`, and such paths count as
   * read (backward compat). PARITY: only the SOLID-read gate TTL-checks these —
   * Python TTL-izes SOLID reads exclusively (require-solid-read.py); the other
   * refsRead consumers (skill-trigger/shadcn/tailwind/design) stay session-scoped.
   */
  refsReadAt?: Record<string, number>;
  /** Framework awaiting doc credit after a Check-1 deny. PERSISTS — {@link recordDoc} cross-credits it on EVERY consultation, never clears it; only the next deny replaces it via {@link recordTarget} (parity track-doc-consultation.py:62). */
  target?: SessionTarget;
  agents: { name: string; ts: number; quality?: AgentQuality }[];
  trivialEdits: number[];
  brainstormRequired?: boolean;
  /** Verification receipts (static-check/test runs, see `tracking/receipt-runners`) at PostToolUse; absent/empty reads as unverified in the TaskCompleted gate (backward compat, fail-closed). See {@link Receipt}. */
  receipts?: Receipt[];
  /** PRD (task/agent ownership coordination) — `agent_id` bound to its resolved agent-report name. Optional: absent on any track predating the PRD module (backward compat). */
  prdOwners?: Record<string, string>;
  /** PRD cross-check violations detected at PostToolUse (capped, append-only). */
  prdViolations?: PrdViolationRecord[];
  /** PRD SubagentStop/Stop one-shot block markers, keyed `"sessionId:event[:agent]"` -> the epoch-ms the block fired. */
  prdStopBlocked?: Record<string, number>;
  /** Nonces of spill events already folded into this snapshot (capped, newest last) — makes a crashed-compaction re-fold idempotent (track-compact). */
  foldedSpills?: string[];
  /** Hash-chain head of the last journal event folded into this snapshot (`seq` + that line's MAC): the next chained line continues from it, and a rolled-back snapshot no longer matches the log (track-chain/track-verify). Absent on a snapshot predating the chain (legacy). */
  chainHead?: { seq: number; mac: string; sid?: string };
  /** In-memory only, never persisted: set by the journal read when integrity verification FAILED (the track is then empty — fail closed). Value = the explicit reason. */
  integrityFailure?: string;
}

/** One PRD cross-check violation, timestamped for the journal/dedup. */
export interface PrdViolationRecord {
  ts: number;
  task: string;
  agent: string;
  sub: string;
  reason: string;
}

/** Cap on {@link SessionTrack.prdViolations} (mirrors the `receipts` style bound — oldest evicted first). */
export const PRD_VIOLATIONS_CAP = 50;
/** A fresh, empty track. */
export function emptyTrack(): SessionTrack {
  return { authorizations: {}, refsRead: [], agents: [], trivialEdits: [] };
}

/**
 * Record a doc consultation (Context7/Exa/web) for a framework in this session:
 * the Check-2 credit (`doc_sessions` + `sources`) plus the Check-1 stamp
 * (`sessions` + `doc_consulted` = ISO of `now`). PARITY track-doc-consultation.py
 * :62-70 — a `target` left by a Check-1 deny (enforce-apex-phases.ts:80) is
 * cross-credited on EVERY consultation, with NO TTL on `target.set_at`, and the
 * target PERSISTS (only the next deny replaces it via {@link recordTarget});
 * single-shot clearing or TTL-gating the target re-opened the deny loop when a
 * consultation landed > TTL after the deny. Immutable.
 */
export function recordDoc(track: SessionTrack, framework: string, sessionId: string, source: string, now: number = Date.now()): SessionTrack {
  const nowIso = new Date(now).toISOString();
  const authorizations = { ...track.authorizations, [framework]: creditDocConsultation(track.authorizations[framework], sessionId, source, nowIso) };
  const t = track.target;
  if (t && t.framework !== framework) {
    authorizations[t.framework] = creditDocConsultation(track.authorizations[t.framework], sessionId, source, nowIso);
  }
  return { ...track, authorizations };
}
/** Set the pending doc-credit target (written by the runtime on a Check-1 deny). Immutable. */
export function recordTarget(track: SessionTrack, target: SessionTarget): SessionTrack {
  return { ...track, target };
}

/**
 * Record that a SOLID reference file was read (deduped). Immutable. When `now`
 * (epoch ms — the tool event's own timestamp, never a fresh `Date.now()`) is
 * supplied, the read is stamped in `refsReadAt`, refreshed on re-reads so the
 * LATEST read drives the SOLID TTL (parity track-solid-reads.py, which appends
 * a timestamped entry per read; require-solid-read.py checks the most recent).
 * Callers that omit `now` keep the legacy untimestamped behavior.
 */
export function recordRefRead(track: SessionTrack, path: string, now?: number): SessionTrack {
  const refsRead = track.refsRead.includes(path) ? track.refsRead : [...track.refsRead, path];
  if (now === undefined) return refsRead === track.refsRead ? track : { ...track, refsRead };
  return { ...track, refsRead, refsReadAt: { ...track.refsReadAt, [path]: now } };
}
/** Record an agent/tool call with a timestamp + optional quality. Immutable. */
export function recordAgent(track: SessionTrack, name: string, ts: number, quality?: AgentQuality): SessionTrack {
  const entry = quality ? { name, ts, quality } : { name, ts };
  return { ...track, agents: [...track.agents, entry] };
}
/** True when ALL of `names` ran within `windowMs` with non-insufficient quality. */
export function agentsFresh(track: SessionTrack, names: string[], windowMs: number, now: number): boolean {
  const cutoff = now - windowMs;
  return names.every((n) => track.agents.some((a) => a.name === n && a.ts > cutoff && a.quality !== "insufficient"));
}
/** Record a trivial edit timestamp (sliding window; old evicted). Immutable. */
export function recordTrivialEdit(track: SessionTrack, ts: number, windowMs: number, now: number): SessionTrack {
  const cutoff = now - windowMs;
  return { ...track, trivialEdits: [...(track.trivialEdits ?? []).filter((t) => t > cutoff), ts] };
}
/** Count trivial edits within the sliding window. */
export function trivialCount(track: SessionTrack, windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return (track.trivialEdits ?? []).filter((t) => t > cutoff).length;
}
/** Set the brainstorm-required flag (from creation-intent detection). Immutable. */
export function recordBrainstormRequired(track: SessionTrack, required: boolean): SessionTrack {
  return { ...track, brainstormRequired: required };
}

/** Bind `agentId` to its resolved PRD agent-report `name` (merge; idempotent no-op if already bound to the same name). Immutable. */
export function recordPrdOwner(track: SessionTrack, agentId: string, name: string): SessionTrack {
  if (track.prdOwners?.[agentId] === name) return track;
  return { ...track, prdOwners: { ...track.prdOwners, [agentId]: name } };
}

/**
 * Append one PRD cross-check violation. Immutable, uncapped in the mutator
 * itself — same append-only shape as {@link Receipt} — so the journal diff's
 * prefix comparison (`tail`, track-diff.ts) never sees an eviction it would
 * mistake for a bulk rewrite. The {@link PRD_VIOLATIONS_CAP} bound is applied
 * only when the journal is folded/read (track-journal.ts's `foldEvents`),
 * mirroring how `trivialEdits`'s sliding window is re-derived at fold time.
 */
export function recordPrdViolation(track: SessionTrack, v: PrdViolationRecord): SessionTrack {
  return { ...track, prdViolations: [...(track.prdViolations ?? []), v] };
}

/** Record a PRD SubagentStop/Stop one-shot block marker (merge). Immutable. */
export function recordPrdStopBlocked(track: SessionTrack, key: string, ts: number): SessionTrack {
  return { ...track, prdStopBlocked: { ...track.prdStopBlocked, [key]: ts } };
}

/** True when the PRD one-shot block for `key` has already fired. */
export function prdAlreadyBlocked(track: SessionTrack, key: string): boolean {
  return track.prdStopBlocked?.[key] !== undefined;
}

import { homedir } from "node:os";
import { resolve } from "node:path";
import { LOCK_FAILED, withTrackLockSync } from "../../tracking/track-lock-sync";
import { sanitizeSessionId } from "../home-state";
import { commandToString } from "../command-string";
import { displayCodeForAction, hashForAction } from "./confirm-code";
import { isSubagentActive } from "./confirm-subagent";
import { typedConfirmCode } from "./confirm-typed-code";
import type { CodexPromptOrigin } from "./codex-prompt-origin";
import type { ConfirmSubmitOutcome } from "./confirm-outcome";
import {
  codexConfirmLockDir, loadCodexConfirmState, saveCodexConfirmState, upsertCodexEntry,
  type CodexAction, type CodexReceipt,
} from "./codex-confirm-state";

const TTL_MS = 5 * 60 * 1000;
const STATE_VERSION = 1;

type RejectReason = "no-token" | "mismatch" | "expired" | "already-consumed" | "missing-tool-use-id" | "state-io";

/** Canonical identity of one Codex shell action and its display token. */
export function codexAction(tool: string, cwd: string, command: unknown, now: number): CodexAction | null {
  const canonicalCommand = commandToString(command);
  if (!canonicalCommand) return null;
  const identity = JSON.stringify({ version: STATE_VERSION, harness: "codex", tool, cwd: resolve(cwd), command: canonicalCommand });
  return { hash: hashForAction(identity), code: displayCodeForAction(identity), command: canonicalCommand, ts: now };
}

/** The session's pending denials, newest first (feedback listing). Pendings never expire — only the cap evicts. */
export function listCodexPendingDenies(sessionIdRaw: unknown, now: number, home: string = homedir()): readonly CodexAction[] {
  const sid = sanitizeSessionId(sessionIdRaw);
  if (!sid) return [];
  try {
    return loadCodexConfirmState(sid, home).pending.slice().reverse();
  } catch {
    return [];
  }
}

/**
 * Atomically authorize or reject a Codex action. A matching fresh receipt
 * (same hash + same tool_use_id) re-allows idempotently; a matching armed
 * token is consumed exactly once (G1/G2/G3). On denial the action is APPENDED
 * to the pending list (cap {@link MAX_CODEX_CONFIRM_ENTRIES}, oldest evicted) —
 * never erasing the other pendings, the armed tokens, or the receipts.
 */
export function authorizeCodexAction(
  sessionIdRaw: unknown,
  action: CodexAction,
  toolUseId: string | undefined,
  now: number,
  home: string = homedir(),
): { allow: true } | { allow: false; reason: RejectReason } {
  const sid = sanitizeSessionId(sessionIdRaw);
  if (!sid) return { allow: false, reason: "state-io" };
  try {
    const result = withTrackLockSync(codexConfirmLockDir(sid, home), () => {
      const buckets = loadCodexConfirmState(sid, home);
      const receipts = buckets.receipts.filter((r) => now - r.ts <= TTL_MS);
      const receipt = receipts.find((r) => r.hash === action.hash);
      if (receipt && toolUseId && receipt.toolUseId === toolUseId) return { allow: true } as const;

      const freshTokens = buckets.tokens.filter((t) => now - t.ts <= TTL_MS);
      const token = freshTokens.find((t) => t.hash === action.hash);

      let reason: RejectReason = "no-token";
      if (token) {
        if (!toolUseId) reason = "missing-tool-use-id";
        else {
          const consumed: CodexReceipt = { ...action, toolUseId };
          saveCodexConfirmState(sid, {
            pending: buckets.pending,
            tokens: freshTokens.filter((t) => t.hash !== action.hash),
            // One receipt per hash, newest wins (upsert) — a stale same-hash
            // receipt must not shadow the fan-out twin of a LATER confirmation.
            receipts: upsertCodexEntry(receipts, consumed),
          }, home);
          return { allow: true } as const;
        }
      } else {
        // Deny-reason parity with the former single slot: computed from the
        // NEWEST token, even an expired one (different hash → mismatch, same
        // hash → expired) — never degraded to "no-token" while a token exists.
        const newest = buckets.tokens.reduce<CodexAction | undefined>((acc, t) => (!acc || t.ts > acc.ts ? t : acc), undefined);
        if (newest) reason = newest.hash === action.hash ? "expired" : "mismatch";
        else if (buckets.receipts.some((r) => r.hash === action.hash)) reason = receipt ? "already-consumed" : "expired";
      }

      if (reason === "missing-tool-use-id") return { allow: false, reason } as const;
      // Pendings never expire (only the cap-10 eviction removes them); the
      // 5-minute TTL applies to armed tokens and receipts only.
      saveCodexConfirmState(sid, {
        pending: upsertCodexEntry(buckets.pending, action),
        tokens: freshTokens,
        receipts,
      }, home);
      return { allow: false, reason } as const;
    });
    return result === LOCK_FAILED ? { allow: false, reason: "state-io" } : result;
  } catch {
    return { allow: false, reason: "state-io" };
  }
}

/**
 * Atomically arm the pending Codex denial whose code was typed, consuming that
 * pending record exactly once (lookup code → full hash; the hash alone then
 * authorizes). A refusal empties ALL pendings and tokens of the session (G5).
 * A classified root prompt may bypass G0; classified subagent/unknown prompts
 * fail closed with NO outcome (an agent relaying a code is not a human
 * confirmation). Returns what happened so the caller can ack it visibly.
 */
export function submitCodexConfirmation(
  sessionIdRaw: unknown,
  text: string,
  now: number,
  home: string = homedir(),
  origin?: CodexPromptOrigin,
): ConfirmSubmitOutcome | null {
  const sid = sanitizeSessionId(sessionIdRaw);
  if (!sid) return null;
  const refusal = /\b(non|no|stop|annule|cancel|abort|nope|laisse tomber|pas maintenant)\b/i.test(text);
  const typedCode = typedConfirmCode(text);
  try {
    const outcome = withTrackLockSync(codexConfirmLockDir(sid, home), (): ConfirmSubmitOutcome | null => {
      const buckets = loadCodexConfirmState(sid, home);
      if (origin !== undefined && origin !== "root") return null;
      if (refusal) {
        saveCodexConfirmState(sid, { pending: [], tokens: [], receipts: buckets.receipts }, home);
        return { kind: "refused" };
      }
      if (!typedCode) return null;
      if (origin === undefined && isSubagentActive(sid, now, home)) return { kind: "frozen", code: typedCode };
      const matches = buckets.pending.filter((p) => p.code.toLowerCase() === typedCode.toLowerCase());
      const chosen = matches[matches.length - 1]; // newest pending wins on a 4-hex collision
      if (!chosen) {
        // The code left `pending` without this call arming it: a fan-out sibling (or an earlier
        // identical submission) already did. READ-ONLY lookup — never re-arm, extend or move
        // anything. A live token wins over a receipt (it is still usable).
        const same = (a: CodexAction): boolean => a.code.toLowerCase() === typedCode.toLowerCase();
        const live = buckets.tokens.filter((t) => now - t.ts <= TTL_MS && same(t)).pop();
        if (live) return { kind: "armed", code: live.code, command: live.command, rerun: true, repeat: true };
        if (buckets.receipts.some(same)) return { kind: "already-consumed", code: typedCode };
        return { kind: "unknown-code", code: typedCode };
      }
      saveCodexConfirmState(sid, {
        pending: buckets.pending.filter((p) => p !== chosen),
        tokens: upsertCodexEntry(buckets.tokens, { ...chosen, ts: now }),
        receipts: buckets.receipts,
      }, home);
      return { kind: "armed", code: chosen.code, command: chosen.command, rerun: true };
    });
    return outcome === LOCK_FAILED ? null : outcome;
  } catch {
    // Submission is advisory state wiring; hook execution must remain available.
    return null;
  }
}

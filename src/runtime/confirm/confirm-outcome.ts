/**
 * The outcome of a typed CONFIRM/refusal at the root prompt, shared by the
 * codex path (codex-confirm.ts) and the shared path (confirm-submit.ts) so
 * confirm-feedback.ts can render one consistent user-visible acknowledgement.
 * Pure type module — no runtime code, no imports (breaks any cycle risk).
 */

/**
 * What happened to a `CONFIRM <code>` / refusal word typed at the root prompt:
 * - `armed`: the code matched a pending deny — its action (and ONLY it, G3) is
 *   now authorized once, for 5 minutes (G1/G2).
 *   Codex-only flags: `rerun` asks the ack to tell the agent to rerun the exact
 *   command now (kimi never sets it: its ack stays byte-identical); `repeat`
 *   marks a resubmission of a code already armed and still fresh (nothing was
 *   minted, extended or moved).
 * - `already-consumed`: (codex) the code's token was already spent on a tool
 *   call (receipt only) — nothing was armed.
 * - `unknown-code`: no pending deny, fresh token or receipt carries this code
 *   (unknown, or expired) — nothing was armed.
 * - `frozen`: a sub-agent is active (G0) — the code was ignored, NOT consumed.
 * - `refused`: an explicit refusal word — every pending deny and armed token of
 *   the session was dropped (G5, widened to the multi-pending lists).
 */
export type ConfirmSubmitOutcome =
  | { readonly kind: "armed"; readonly code: string; readonly command: string; readonly rerun?: true; readonly repeat?: true }
  | { readonly kind: "already-consumed"; readonly code: string }
  | { readonly kind: "unknown-code"; readonly code: string }
  | { readonly kind: "frozen"; readonly code: string }
  | { readonly kind: "refused" };

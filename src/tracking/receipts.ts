/**
 * @module receipts
 * Verification receipts: capture a static-check or test run at PostToolUse and
 * query the freshest PASSING one for the TaskCompleted (hard) and SubagentStop
 * (advisory) gates. A "done" over modified code files is refused unless such a
 * receipt exists — mechanising "no proof, no done". Command recognition spans
 * many ecosystems (TS/JS, Python, Go, Rust, PHP, Swift, Dart) via the ordered
 * {@link RunnerSpec} table in `./receipt-runners`; which command text is even
 * eligible, and the structural "last segment" / output-suppression rules,
 * live in `./receipt-command`.
 *
 * Threat model (explicit): a receipt guards against FORGETTING to verify and
 * against honest shortcuts (a run whose output/exit code was accidentally
 * discarded, an informational invocation, a filtered run) — it is NOT a
 * security control against an agent that deliberately fabricates tool
 * output, same caveat as the `CONFIRM` code in the README.
 * @packageDocumentation
 */
import { withTrack, trackJournalEnabled } from "./store";
import { readTrackSync } from "./track-compact";
import { matchRunner, stripAnsi } from "./receipt-command";
import { unquotedShellText } from "../policy/guards/bash-write-unquoted";
import type { SessionTrack } from "./session-state";

/**
 * A verification receipt captured at PostToolUse from a Bash verification
 * command. Feeds the TaskCompleted receipt gate: a "done" over modified code
 * files is refused unless a fresh, passing receipt (`exitCode === 0`, `fail === 0`)
 * exists. `pass`/`fail` are parsed only for test runs; a static check (`kind:
 * "tsc"` — the literal is historical, it now means "static check": `tsc`,
 * `mypy`, `pyright`, `phpstan`, `go vet`/`build`, `cargo check`/`clippy`,
 * `swift build`) carries the exit code alone.
 */
export interface Receipt {
  kind: "tsc" | "test";
  /** The matched runner's tool name (`bun test`, `pytest`, `cargo test`, …). Absent on receipts predating this field — still verifiable via `kind`/`exitCode`/`fail` under the legacy branch of {@link isPassing}. */
  tool?: string;
  exitCode: number;
  pass?: number;
  fail?: number;
  ts: number;
  /**
   * When the verified run STARTED (epoch ms; `ts` minus the tool duration). Only files edited after this are unverified.
   * Absent when the host sent no `duration_ms` (optional in Claude Code) and on older receipts: the gate then ignores it
   * and behaves EXACTLY as before `verifiedAt` existed (fresh receipt within TTL x5, no edit-time cut-off). No PreToolUse
   * start time is recorded for Bash `tool_use_id`s, so a start time is never guessed.
   */
  verifiedAt?: number;
}

/**
 * A single recognised verification command: which {@link RunnerSpec.kind} it
 * produces, its anchored command regex, and an optional pass/fail parser for
 * its output format.
 */
export interface RunnerSpec {
  tool: string;
  kind: "tsc" | "test";
  cmd: RegExp;
  counts?: (output: string) => { pass?: number; fail?: number };
}

/** Append a verification receipt to the track. Immutable. */
export function recordReceipt(track: SessionTrack, receipt: Receipt): SessionTrack {
  return { ...track, receipts: [...(track.receipts ?? []), receipt] };
}

/**
 * Classify a Bash command as a verification receipt via {@link matchRunner}
 * (`./receipt-command`: ordered `RUNNERS` table, first match wins, scoped to
 * the last shell list segment), or `null` when it resolves to none — a
 * zero-test/informational invocation, a runner sitting only in an EARLIER
 * list segment (`bun test && git commit`, `bun test || true`), or a runner
 * whose own segment suppresses its output after the match, none of which is
 * proof of anything. Runner regexes are tested against
 * `unquotedShellText(command)` (quote/heredoc/comment-stripped), never the
 * raw command, so a tool name mentioned inside a commit message, heredoc
 * body, or `echo`d string is never mistaken for a real invocation (H1).
 * `output` is ANSI/CR-stripped once ({@link stripAnsi}) before any
 * test-kind runner parses its pass/fail counts.
 * @param command - The Bash command line.
 * @param output - Combined stdout+stderr (bun writes its summary to stderr).
 * @param exitCode - The command's exit code.
 * @param now - Capture timestamp (epoch ms).
 * @param durationMs - Host-reported tool run time (`payload.duration_ms`); when a positive finite number, sets `verifiedAt = now - durationMs`.
 */
export function classifyReceipt(command: string, output: string, exitCode: number, now: number, durationMs?: number): Receipt | null {
  const unquoted = unquotedShellText(command);
  const runner = matchRunner(unquoted);
  if (!runner) return null;
  const counts = runner.counts?.(stripAnsi(output)) ?? {};
  const base: Receipt = { kind: runner.kind, tool: runner.tool, exitCode, pass: counts.pass, fail: counts.fail, ts: now };
  // `verifiedAt` only when the host reported a duration; otherwise it is absent and the gate keeps its TTL-only rule (receipt shape unchanged).
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? { ...base, verifiedAt: now - durationMs } : base;
}

/**
 * A receipt PROVES success only via POSITIVE evidence (D1: "no counts
 * observed" is no longer treated as proof): exit 0, plus — for `kind:
 * "test"`, a reported pass count strictly greater than 0 AND zero reported
 * failures (an unreported pass count proves nothing was ever executed); for
 * `kind: "tsc"` (static check), an EXPLICIT `fail === 0` (an undefined
 * `fail` — no success signature and no diagnostic count observed — proves
 * nothing either).
 *
 * Legacy compat: a receipt recorded before the `tool` field existed (`tool
 * === undefined`, the historical marker) keeps the PRE-fix contract so old
 * signed tracks are not retroactively invalidated: `test` kind passes on
 * `pass > 0 && fail === 0` (unchanged), `tsc` kind passes on `exitCode === 0`
 * alone (the old contract never inspected `fail` for a static check).
 */
function isPassing(r: Receipt): boolean {
  if (r.exitCode !== 0) return false;
  if (r.tool === undefined) {
    if (r.kind === "tsc") return true;
    return (r.pass ?? 0) > 0 && (r.fail ?? 0) === 0;
  }
  if (r.kind === "test") return r.pass !== undefined && r.pass > 0 && (r.fail ?? 0) === 0;
  return r.fail === 0;
}

/** The newest passing receipt within `windowMs`, or `null`. */
export function freshPassingReceipt(track: SessionTrack, windowMs: number, now: number): Receipt | null {
  const cutoff = now - windowMs;
  const hits = (track.receipts ?? []).filter((r) => r.ts > cutoff && isPassing(r));
  return hits.length ? hits.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
}

/**
 * Start time of the NEWEST passing run (by `ts`, any age): the cut-off after which
 * an edited file is unverified again.
 * @param track - The session track.
 * @returns That receipt's `verifiedAt`, or `null` when there is no passing receipt or the newest one carries none
 *   (a duration-less newest run keeps the pre-`verifiedAt` TTL-only rule, even if an older run recorded a start).
 */
export function newestPassingVerifiedAt(track: SessionTrack): number | null {
  const passing = (track.receipts ?? []).filter(isPassing);
  if (passing.length === 0) return null;
  const newest = passing.reduce((a, b) => (b.ts > a.ts ? b : a));
  return newest.verifiedAt ?? null;
}

/**
 * File variant of {@link newestPassingVerifiedAt}; `null` on any read/verify failure
 * (the caller then applies its pre-`verifiedAt` TTL-only rule).
 * @param file - Path of the signed session track.
 */
export function verifiedAtFromFile(file: string): number | null {
  try {
    return newestPassingVerifiedAt(readTrackSync(file, trackJournalEnabled()));
  } catch {
    return null;
  }
}

/**
 * Sync variant reading the track directly (snapshot ⊕ journal) — for the sync
 * gates (TaskCompleted / SubagentStop). Returns the newest passing receipt, or
 * `null` on any read/verify failure (fail-closed: no proof ⇒ unverified).
 */
export function freshReceiptFromFile(file: string, windowMs: number, now: number): Receipt | null {
  try {
    return freshPassingReceipt(readTrackSync(file, trackJournalEnabled()), windowMs, now);
  } catch {
    return null;
  }
}

/**
 * Capture a verification receipt from a PostToolUse Bash command into the signed
 * track (best effort — a non-verification command is a no-op).
 */
export async function captureReceipt(file: string, command: string, output: string, exitCode: number, now: number, durationMs?: number): Promise<void> {
  const receipt = classifyReceipt(command, output, exitCode, now, durationMs);
  if (!receipt) return;
  await withTrack(file, (track) => recordReceipt(track, receipt));
}

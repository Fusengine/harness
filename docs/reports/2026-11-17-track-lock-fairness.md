# Track lock fairness (H3 CI flake) — report 2026-11-17

Branch `fix/track-lock-fairness` (uncommitted), base `aefa7d5`.

## Root cause

`test/track-journal-race.test.ts` "H3 race" failed on `not.toContain("write skipped")`. In journal
mode the only code that could print that line was `maybeCompactJournal` → async `withTrackLock`:
fixed 8 ms poll, private 400 ms budget, no jitter, no release-side step-aside. Appenders
(`withTrackLockSyncBlocking`: jittered 1-4 ms backoff, ~0.5 ms hold, step-aside) re-take the lock
continuously, so the rare taker (compaction, 2-6 ms hold) starved **as a lock taker** (not slowness).

Reproduction (24-worker replica of the H3 test, 3 busy loops, `scripts` in the session scratchpad):

| | runs | runs with a skipped compaction | skipped compactions | lost events |
|---|---|---|---|---|
| base `aefa7d5` (cap 32K / 8K / 4K) | 7 | 3 | 1, 1, 2 | 0 |
| fixed | 23 | 0 | 0 | 0 (0 spilled) |

Real loss paths found besides H3: legacy `FUSE_TRACK_JOURNAL=0` `withTrack` returned `false` and
dropped the write on lock timeout; `withTrackLockSync` callers (prd-stop-gate, prd-subagent-stop,
evidence-harvest-io, solid-notice, codex-confirm) gave up after a private 400 ms.

## Fix

- `src/tracking/track-lock-fair.ts` (new): shared `backoffMs` (jittered, capped 1/2/4/8 ms),
  `markContended` / `stepAsideMs` (moved from track-lock-sync).
- `track-lock.ts`: async `withTrackLock` uses the shared budget (`FUSE_TRACK_LOCK_BUDGET_MS`, default
  1000) + the same backoff + step-aside (async sleeps: in-process awaiting holders cannot deadlock).
- `track-lock-sync.ts`: `withTrackLockSync` is now the blocking twin plus the named stderr line
  (same budget, same fairness, stale reclaim).
- `track-compact.ts`: `maybeCompactJournal` takes the blocking fair lock and returns
  `CompactStatus = "idle" | "compacted" | "skipped" | "failed"`. A deferral past the budget is a
  returned status (stderr keeps the phrase "write skipped" on purpose so H3 still detects a starved
  compaction); the log keeps every event.
- `track-legacy-spill.ts` (new) + `store.ts`, `prd-stop-gate.ts`, `prd-subagent-stop.ts`,
  `evidence-harvest-io.ts`: when the budget expires in the legacy path, the mutation diff is written
  as signed spill files (journal mode folds them) instead of being dropped; spill failure is logged.
  `withTrack` still returns `false` (not applied to the snapshot).
- Stale comments corrected (store.ts header and `withTrack` doc, track-compact module doc, track-lock header).

## Latency (measured, single process, then loaded)

- append: p50 0.42 ms, p99 1.3 ms (5 ms / max 100 ms around a 128 KiB compaction), compaction 1.2-5.5 ms.
- Worst case per lock wait: bounded by the shared budget, 1000 ms (was 400 ms for `withTrackLockSync`
  callers and compaction). Per hook, when the lock is truly stuck: (K+1) x 1000 ms for a journal write
  changing K fields (one append wait per field, plus one compaction wait), plus 1000 ms for the
  `prd-claim` lock in `prd-claim-bind`. A stale lock (dead holder) is reclaimed after the 10 s TTL (unchanged).

## Verification (final state)

- H3 `bun test test/track-journal-race.test.ts`: 30/30 isolated pass, 30/30 pass under 3 busy loops.
- 24-worker replica under load: 23 runs, 0 skipped compaction, 0 lost, 0 spilled (base: skips in 3 of 7 runs).
- Full suite (`bun test`, 5809 pass / 3 skip / 13 fail, ran under load 9-10 with 5 suites in parallel): all 13
  failures are 5 s CLI-spawn timeouts (and 3 x 300 s sim timeouts); re-run isolated: 194 pass / 0 fail on the 8
  files, `multi-rdv-sim` 8 pass / 0 fail. One intermediate isolated re-run also failed
  `guard-report-bg-e2e` (2 tests at ~5 s) under load, passed 3/3 on mine and 3/3 on base afterwards: load-induced.
- `bunx tsc --noEmit` exit 0; `git diff --exit-code aefa7d5 -- test/track-journal-race.test.ts` clean.
- challenger (final state): CONFIRMED.
- 24 concurrent writers: wall 4.0-5.5 s for 3700 events vs 4.7-5.4 s on base (no throughput regression).

## Tests

New: `test/track-lock-shared-budget.test.ts` (8): async lock, sync lock, compaction and legacy `withTrack`
wait out a 600 ms holder (RED on base: 400 ms budget / dropped write), compaction past a short budget returns
`skipped`, legacy `withTrack` past the budget spills and the write is readable via the journal, sync legacy caller
(`updateTrackSync`) same, async lock stays bounded. RED on base: 7/7 first batch + the sync-caller test.
`test/track-lock-starvation.test.ts` (1): 24 tight-loop appenders + 30 compaction passes: every pass `compacted`,
0 "write skipped", 0 lost. (Starvation itself is statistical on base — the deterministic RED is the budget test;
the replica numbers above are the statistical proof.)
`test/track-journal-race.test.ts` is byte-identical to base (`git diff --exit-code aefa7d5`).

## Residual risks (flagged once)

- Legacy `withTrack` spills and returns `false` after the budget; `prd-claim-bind` then answers "retry". If the
  retry loses the slot and the owner later switches back to journal mode, the folded spill could duplicate an owner.
  Rare (legacy kill-switch only, lock must stay busy > 1 s).
- `codex-confirm` / `solid-notice` still skip on a lock busy > 1 s (non-track data, no spill possible); fewer
  than before (budget 400 → 1000 ms with fair polling).

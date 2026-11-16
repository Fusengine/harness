# multi-rdv-sim flake: root cause (2026-11-15)

Verdict: NOISE, not a regression of v0.1.120. No source change made.

## Context
Publish v0.1.120 (run 43692977420) and one CI attempt failed `test/multi-rdv-sim.test.ts` scenario
`01-filesize-block-then-comply.json` (sim scenarios under rendezvous fan-out). CI on `main` at 08:06:22 passed,
Publish of the same commit at 08:06:49 failed: same code, different outcome.

## Measurements (this machine, load average 13-18 from other sessions)
Command: `bun test test/multi-rdv-sim.test.ts -t 01-`, new = a69f909 (worktree `fuse-harness-wt-rdvfix`),
base = 5d5c963 (worktree `fuse-harness-wt-mainbase`), interleaved.

| Condition | new (a69f909) | base (5d5c963) |
|---|---|---|
| default, 30 runs each | 8 fail / 30 | 7 fail / 30 |
| full suite looping in parallel, 12 runs each | 1 fail / 12 | 1 fail / 12 |
| median wall of one `core` hook process (30 alternating) | 182 ms | 183 ms |

Fisher exact 8/30 vs 7/30: p = 1.0. All 15 idle failures carry `[REPEAT] ... Identical attempt #2` on the 150-line
Write steps (stdin 2824 bytes).
Full `bun test`: new 5659 pass / 4 fail (01-filesize flake, Cursor CLI stdout bytes, `harness prd validate`,
PRD router 13-lessons); base 5335 pass / 2 fail (Cursor CLI stdout bytes, `harness prd validate`: the same two as new).
The two extra failures on new (01-filesize, PRD router 13-lessons) are load flakes: 13-lessons passes 3/3 in
isolation on both trees. `bunx tsc --noEmit` exit 0 on new.

## Mechanisms (two, both wall-clock / order dependent state shared by sibling hook processes)
1. Local failures: `deny-loop` burst folding. `src/runtime/deny-loop-store.ts` + `src/policy/deny-loop.ts` fold a
   record landing within `BURST_DEDUP_MS` (2000 ms, `src/runtime/burst-window.ts`) of the first identical deny. When
   the 14-process fan-out spreads wider than 2 s (machine load), later processes count as attempt #2 and render
   `[REPEAT]`. Which process crosses the window differs between the concurrent pass B and the sequential pass A in
   `test/multi-differential.ts`, so stdout and `stdoutLength` differ. Already documented by 0fec723 (2026-10-05,
   "fixes burst-window false repeats on CI").
2. CI failure (step 3, small Edit, stdin 147 bytes; challenger-verified from the CI log):
   - Trivial-edit budget race: `src/runtime/gate-apex.ts:83-85` reads `trivialCount(track,...) < TRIVIAL_BUDGET` from
     the track loaded earlier and writes via `withTrack(...recordTrivialEdit)` afterwards. Two concurrent core siblings
     can both read 3 and both be allowed; sequential pass A allows 4 and denies the 5th. So index 4 is allowed in B
     (empty stdout) while A denies it (694 bytes).
   - 694 vs 640 bytes: the extra 54 bytes are the `systemMessage` deny notice, attached once per window
     (`src/runtime/deny-notice.ts:50`, `onceExclusive(..., BURST_DEDUP_MS)`): first deny of the burst gets it.

## Why the v0.1.120 branch is not the cause
Files of both mechanisms (`gate-apex.ts`, `src/tracking/*`, `deny-loop-store.ts`, `policy/deny-loop.ts`,
`deny-notice.ts`, `burst-window.ts`) are untouched in 5d5c963..a69f909. `gate.ts` changed one line (passes `agentId`).
`leadScopeGate` returns null for this payload (no `transcript_path`; only Agent/Task/SendMessage). `track-changes.ts`
(`leadFiles`/`agentType`) runs on PostToolUse only; `outcomeStopGate` on Stop only. Hook declarations (fan-out size)
unchanged. Per-process latency identical.

## History
CI + Publish since 2026-10-05: 70 runs, scenario 01 failed 0 times before 2026-11-15; other flakes were perf
(`unquotedShellText`) and bash-write tests. Locally the test fails ~25% when the machine is loaded, so CI rarely
trips it; the 2026-11-15 failure is a tail event of a known flaky oracle.

## Not verified
- The CI signature (trivial-budget race) was not reproduced locally: 0 occurrences in 84 local runs on either tree
  (needs zero stagger on step 3 only). Mechanism established by code reading + CI log, not by reproduction.
- n=30 cannot exclude a shift smaller than ~25 points between the trees.

## Fix options (not applied, outside the "noise: do not change code" mandate)
Test-only: retry-visible oracle, or make the oracle order-insensitive for state-folding outputs. Source: make
`recordTrivialEdit` a check-and-charge under one `withTrack` lock. Either needs the owner's go.

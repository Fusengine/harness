# Batch resume note — 2026-11-10 (pause)

Owner (relayed): « après on met en pose je dois dormir ». In-flight rounds finished; only CONFIRMED items were WIP-committed; refuted items were not relaunched. Nothing pushed, no integration branch, no release request, no probe deleted. Decisions: `docs/decisions.md`.

## State per item

| # | Item | Branch / worktree | State |
|---|------|-------------------|-------|
| 1 | English messages | `fix/english-user-messages` (main checkout) | DONE, CONFIRMED. WIP f39c869 (+ docs e9bc4ea, test 7b4e3e7; decisions 2e27a35, 0596210, 7c3132d) |
| 2 | Scanner coverage | `feat/security-scan-coverage` (`../fuse-harness-wt-scan`) | DONE, CONFIRMED. WIP a4d4668 |
| 3 | #121 cartographer | `fix/cartographer-bounded-read` (`../fuse-harness-wt-carto`, based on a4d4668) | DONE, CONFIRMED. WIP f67bc2e (24 files, +1332/−138). Issue NOT commented/closed (needs merge + npm publish + owner's direct go) |
| 4 | Stop/SubagentStop guards | `fix/stop-guard-attribution` (`../fuse-harness-wt-guard`) | REFUTED, uncommitted. Owner bound (guards still block real project code, lead + sub-agent) CONFIRMED on 74 runs. Refuted only on secret masking (a): over-redacts legitimate text in the recovered report — `const password = getPassword(input)`, `apiKey = process.env.API_KEY`, `tokenizer=cl100k_base`, `token_endpoint: https://…`, `"tokenCount": "1234"`, `"token_type": "Bearer"`, `"secretName"`, `"passwordPolicy"` |
| 5 | Scratchpad redirect | `fix/scratchpad-redirect` (`../fuse-harness-wt-redir`) | REFUTED, uncommitted. Owner's exact command passes, writes nothing outside the scratchpad; without `scratchpad_dir` verdicts identical to main on 87 rows. Counter-examples (only with `S` already in the environment, or root): (a) NEW `true ||⏎S=D; echo x > $S/f` writes the project file (bash + zsh) — newline after `||` accepted at `bash-write-scratchpad-var.ts:24`; (b) NEW `true |⏎S=D; …` (bash only); (c) known G10 residual `false && S=D; … > $S/f` / `cd <missing> && S=D; …` — the owner's own command shape when `cd` fails |
| 6 | Temp-dir recursive delete (security.ts:22) | planned on `fix/scratchpad-redirect` | NOT STARTED (pause) |
| — | Receipt dedupe | `fix/receipt-dedupe` | Parked WIP 7dbf31e (owner decision), out of this batch |

Sniper on the redirect branch: see the "sniper-redir" line at the end.

## Uncommitted files per worktree

- Main checkout: `MEMORY/LESSON.md`, `.kimi/`, `.kimi-code/` (owner's, never touched), plus this note (`docs/batch-resume-2026-11-10.md`, untracked, not committed on main).
- wt-scan, wt-carto: clean.
- wt-guard: M `src/runtime/handle-post.ts`, `src/runtime/lifecycle-bridge.ts`, `src/runtime/lifecycle/{agent-files,agent-memory,code-edit-time,task-completed,track-changes}.ts`; new `src/runtime/lifecycle/{project-code,redact-text,report-prune,report-recovery}.ts`, `test/guard-{attribution,project-code,report-recovery}.test.ts`, `test/guard-fixtures.ts`.
- wt-redir: M `src/adapters/claude/index.ts`, `src/policy/guards/{bash-write,context}.ts`, `src/policy/interfaces/types.ts`, `src/runtime/{gate-input,gate,handle-pre,normalize}.ts`; new `src/policy/guards/bash-write-scratchpad{,-target,-var,-words}.ts`, `test/bash-write-scratchpad-{corpus,plumbing,redirect}.test.ts`, `test/helpers/redir-corpus{,-a,-b}.ts`.

## Left before integration

1. Stop guards: one round on masking (a) only — redact values, never ordinary identifiers/keys; corpus of the 8 strings above stays byte-identical; then sniper + challenger + WIP.
2. Redirect: reject an `S=` binding whose preceding non-empty statement ends with `&&`, `||` or `|` including across newlines; the G10 residual needs an owner decision (accept, or apply the exception only when `S` is not set in the hook's environment). Then sniper + challenger + WIP.
3. Temp-dir delete round (decision 2026-11-10, security.ts:22) on `fix/scratchpad-redirect`, sniper + challenger + WIP.
4. Local integration branch (never main, nothing pushed) of the six branches; full suite + tsc + redirect corpus + stop-gate replays; final challenger "does anything main blocked/asked now pass silently beyond the owner-approved cases?". Behaviour changes to name in the release request: guard case 04 (edit via the real /tmp path of a file the project only links to: main blocks, branch passes), case 19 stricter, R3b (each agent held for its own files), no sniper demand for temp/scratchpad out-of-root files.
5. Ask the owner directly for the release go; after merge + npm publish and the owner's go, comment and close #121 with the challenger-corrected sentence.

## Probe directories (not deleted — `rm -rf` blocked by the Dangerous-command hook, never bypassed)

- `/var/tmp/chg3` (~84 MB), `/var/tmp/chg4` (~105 MB), `/var/tmp/chg5`
- `/private/tmp/chg3`, `/private/tmp/chg4`, `/private/tmp/chg5`
- `/private/tmp/claude-501/chg3slug`, `chg4slug`, `chg5slug`
- `$TMPDIR/chg3-*`, `chg3p-*`, `chg4-*`, `chg4p-*`, `chg5-*`, `chg5p-*`
- Test residue in `$TMPDIR`: `fh-*`, `twin-*`, `oracle-*`, `motion-*`, `dsolid-*` (~3000+)

## First three actions on resume

1. Stop-guard masking (a) round → sniper → challenger → WIP on `fix/stop-guard-attribution`.
2. Redirect fix (newline after `&&`/`||`/`|`) + ask the owner the one G10 question → then the temp-dir delete round, both on `fix/scratchpad-redirect`, each with sniper → challenger → WIP.
3. Integration branch + full suite/tsc/replays + final challenger → ask the owner for the release go (then #121 comment + close on his go).

## Answers carried over

- "Noise ~67 %" (scanner): of 15 sampled NEW findings (not produced by the legacy scanner), ~10 are noise (md5/sha1 cache keys, `execSync` in tests, test fixtures, `Math.random` ids), 0 exploitable, 2–5 need review. Previous design was ~93 % noise on the same sample. Legacy findings are untouched (legacy ⊆ new is a test).
- Scanner languages: JS/TS (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`), Vue, Svelte, Astro, PHP, Python, Swift, Go, Rust, Ruby, Java, Kotlin, C#, plus language-agnostic secret patterns in text/config files. Coverage block: last key `coverage` {patternSetVersion "2026.11.2", primaryLanguage, languages, filesScanned, patternsApplied, totals, projects, skipped, unsupported, limits}; each finding gains `id`, `cwe`, `owasp`, `language` after the legacy keys.
- Cartographer described extensions (26): `.md .js .jsx .mjs .cjs .ts .tsx .mts .cts .vue .svelte .astro .php .phtml .inc .py .pyw .swift .go .rs .rb .rake .erb .java .kt .kts .cs`.
- anthropics/claude-code#85917 — https://github.com/anthropics/claude-code/issues/85917 — maintainer: the parent receiving the sub-agent's last message "is how subagent results work today"; closed by the stale bot.

## sniper-redir

PASS, no edit: `bun test test/bash-write test/parity` 995 pass / 1 skip / 0 fail; `bunx tsc --noEmit` 0; jscpd no clone on branch files; largest file 179 lines; no existing test modified. Out of scope: `RUNNERS` (`bash-write-scratchpad-words.ts:24`) copies 12 prefixes of `SAFE_PREFIXES` (`bash-write-patterns.ts:158`) — divergence risk, left as is. The branch stays uncommitted because the challenger REFUTED it.

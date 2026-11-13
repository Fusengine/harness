# Combined build verification, 2026-11-12

Worktree `fuse-harness-wt-combined`, branch `fix/combined-2026-11-12`, HEAD `143ccca`. No source file changed. Only `dist/` (gitignored) was written.

## 1. Typecheck
`bunx tsc --noEmit`: exit 0.

## 2. Full suite
`HOME=$(mktemp -d) bun test`: 5010 pass / 3 skip / 1 fail, 5014 tests, 462 files, 326 s.

Failure: `test/multi-rdv-sim.test.ts` > `sim scenarios under rendezvous fan-out > 01-filesize-block-then-comply.json`.
Error: `expect(s.outputDiffs).toEqual([])`; the B (fan-out) side's deny carries a `[REPEAT]` prefix ("Identical attempt #2 already denied...") that the A side lacks, so stdout and stderr differ on steps 0 and 1.

Pre-existing, not introduced by the merge. Running that test file alone (7 pass, 1 fail, same test) on every tip fails identically:
- combined 143ccca
- remote 01b99bd
- f4 0f5f491
- wc 7315804
- cxweb 0c78291
- main aa1d13c (wt-f1-base1, the common base)

Root cause was not investigated (non-goal).

## 3. Reference corpus (790 commands, MONO_STRIDE=40, host claude-code, scope core)
Runner: scratch script importing `corpus(40)` from `test/bash-write-monotone/differential.ts`, same fixture as its `run` mode, one process per command, fresh HOME and session_id per process, concurrency 2.
Builds: combined `bun src/cli/bin.ts` vs installed `~/.claude/plugins/marketplaces/fusengine-plugins/plugins/node_modules/@fusengine/harness/dist/cli/bin.mjs` (package.json 0.1.115; dist mtime Nov 12 11:08; read-only).

Note: the path given in the brief (`dist/bin.mjs`) does not exist; the bin is `dist/cli/bin.mjs`. A first run against the wrong path gave 790 "error" rows; it was discarded and rerun.

| Result | Count |
|---|---|
| same | 788 |
| stricter allow->ask | 2 |
| stricter allow->deny / ask->deny | 0 |
| WEAKER (deny->ask, deny->allow, ask->allow) | 0 |
| error rows | 0 |

Stricter rows (one gate: dangerous-command `eval`, `[CONFIRM] Dangerous command DANGEROUS PATTERN: eval`):
- `deny-atom/2` `bash -s <<'CTX1'\neval 'sed -i.bak s/orig/pwned/ src/x.ts'\nCTX1` : installed allow, combined ask
- `deny-atom/2` `sh <<'CTX1'\neval 'perl -pi -e s/orig/pwned/ src/x.ts'\nCTX1` : installed allow, combined ask

## 4. Control rows (cwd = a git fixture's `sub/`, row b5 in a linked worktree's `sub/`)
| id | command | combined | installed | remote 01b99bd | f4 0f5f491 | wc 7315804 |
|---|---|---|---|---|---|---|
| a1 | `ssh host 'rm -rf /tmp/x'` | ask | ask | ask | ask | ask |
| a2 | heredoc `rm -rf /tmp/x` piped to ssh | allow | allow | allow | allow | allow |
| a3 | `ssh host 'cat f' \| sh` | ask | allow | ask | allow | allow |
| a3b | `ssh host 'cat f' \| bash` | ask | allow | ask | allow | allow |
| a4 | `rm -rf /` | deny | deny | deny | deny | deny |
| a5 | `rm -rf ~` | deny | deny | deny | deny | deny |
| a6 | `rm -rf trash/x` | ask | allow | allow | ask | allow |
| a7 | `ssh host 'ls'` | allow | allow | allow | allow | allow |
| b1 | `git push origin main` | ask | ask | ask | ask | ask |
| b2 | `git -C x push origin main` | ask | allow | allow | ask | allow |
| b3 | `cd x && git push origin main` | ask | ask | ask | ask | ask |
| b4 | `gh pr merge 1 --squash` | deny | allow | allow | deny | allow |
| b5 | `git commit -m x` in worktree | ask | ask | ask | ask | ask |
| b6 | `env A=1 git commit -m x` | ask | ask | ask | ask | ask |
| b7 | `git commit -m x` (main checkout) | ask | ask | ask | ask | ask |

Combined is equal to or stricter than the strongest source branch on every row; no merge regression. Combined is stricter than installed on a3, a3b, a6, b2, b4. a2 (heredoc piped to ssh) is allow on every build including installed: unchanged, not a regression, but not covered by any branch either.

## 5. Build
`bun run build` (tsdown, package.json script): exit 0, 126 files, 1.81 MB, 300 ms. `dist/` is gitignored.
The entry the package exposes is `dist/cli/bin.mjs` (`dist/bin.mjs` does not exist).
`shasum -a 256 dist/cli/bin.mjs` = `02238770f93e528c66593a577b71b03087dca657d482ef01286a198c15023500`.

## 6. TMPDIR residue
`du -sh` before / after: `$TMPDIR` 28G / 28G, `/private/tmp` 36G / 34G.
Moved with `mv` to `~/.Trash/verify-combined-2026-11-12/` (2.9G): 1711 dirs from `$TMPDIR` newer than the start marker (fh-*, motion-*, twin-*, oracle-*, dsolid-*, tmp.* HOMEs), plus my scratch HOME and fixture dirs. Space returns only when the Trash is emptied. The pre-existing ~28G in `$TMPDIR` was not touched (older than the start marker).

## Not verified
- The pre-commit worktree lint action itself (only the gate verdict `ask` on `git commit` was compared, identical on all builds); covered by the suite only.
- Hosts codex, kimi, cursor on the corpus (only claude-code, as briefed).
- Root cause of the multi-rdv-sim failure.
- The built `dist/` was not executed against a corpus.

## 7. Reference corpus rerun on the final build 3ca624b (2026-11-13)

- Worktree HEAD: `3ca624b fix(combined): restore the strictest verdict lost in the merges`.
- sha256 combined (worktree `dist/cli/bin.mjs`): `d80e6ef1e81754d84b9223f6efa83b1c3d151a8b3a5714ac1bd138060b1087fa`.
- sha256 installed (marketplace `node_modules/@fusengine/harness/dist/cli/bin.mjs`, read-only): `29de5e5440be0a211a3c77cdb5ab33eccbd97b2bcac4636f53550963e173668a`.
- Settings: same as section 3 (`corpus(40)` from `test/bash-write-monotone/differential.ts`, same fixture layout, `bun <bin> hook claude-code core`, fresh HOME + session_id per process, concurrency 2, 30 s timeout). Only difference: combined = the built dist (`dist/cli/bin.mjs`), not `src/cli/bin.ts`.
- Run: 790 commands x 2 builds, about 56 s wall clock. Artifacts (scratchpad `verify-final/`): `corpus-result.json`, `analysis.txt`.

| Outcome | Count |
|---|---|
| same verdict | 788 |
| stricter: allow -> ask | 2 |
| stricter: other transitions | 0 |
| WEAKER | 0 |
| errors | 0 |

WEAKER rows: none.

Stricter rows (installed allow -> combined ask, reason `[CONFIRM] Dangerous command DANGEROUS PATTERN: eval`):
- `deny-atom/2` `bash -s <<'CTX1'\neval 'sed -i.bak s/orig/pwned/ src/x.ts'\nCTX1`
- `deny-atom/2` `sh <<'CTX1'\neval 'perl -pi -e s/orig/pwned/ src/x.ts'\nCTX1`

Comparison with section 3 (src build): 788 same / 2 stricter / 0 weaker there, identical here on the built dist, same two rows.

## Install 2026-11-13

Owner-named target: `~/.claude/plugins/marketplaces/fusengine-plugins/plugins/node_modules/@fusengine/harness/dist`.

- Preconditions OK: source `dist/cli/bin.mjs` sha d80e6ef1...; installed sha 29de5e54... before; Trash target absent; `dist.bak-2026-11-11-0115` present.
- Old dist moved to `~/.Trash/harness-dist-8168d0a-2026-11-13`; combined dist copied with `cp -Rp`.
- Proof: `diff -rq` empty; installed `cli/bin.mjs` sha d80e6ef1...; `dist.bak-2026-11-11-0115` mtime unchanged (1794344671); package.json/src/assets untouched.
- Hook calls through the installed bin (HOME=mktemp, scratch git fixture, fresh session ids): `ls` allow; `rm -rf /` deny; `gh pr merge 1 --squash` deny; `ssh host 'cat f' | sh` ask; `git -C x push origin main` ask; codex and kimi `rm -rf /` deny. All exit 0.
- Full suite on the combined worktree: 5042 pass / 3 skip / 1 fail (known `01-filesize-block-then-comply`); `tsc --noEmit` exit 0.
- Rollback: `D=~/.claude/plugins/marketplaces/fusengine-plugins/plugins/node_modules/@fusengine/harness; mv "$D/dist" ~/.Trash/harness-dist-combined-2026-11-13 && mv ~/.Trash/harness-dist-8168d0a-2026-11-13 "$D/dist"`

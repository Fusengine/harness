# Real-condition results — ask->block build installed in Claude harness (2026-11-11)

Build: repo commit `aa1d13c` (branch `fix/bash-write-ask-to-block`), `package.json` 0.1.117, `dist/cli/bin.mjs` sha256 `3d38651f7db7c92c404e79ea5590474776f0283badeca1ab8845d714e8ac02cb` (127 files).
Previously deployed: sha256 `5944a2ea9aacd221544ced9dff109b629b93e4ebcfe02488301958334dadf007` (0.1.115).

## Install

- Target (only path written outside the repo): `~/.claude/plugins/marketplaces/fusengine-plugins/plugins/node_modules/@fusengine/harness/dist`
- Backup (cp -Rp, `diff -rq` identical): `.../harness/dist.bak-2026-11-11-0115`
- Replaced dist moved to `~/.Trash/harness-dist-replaced-2026-11-11`
- New dist = repo `dist/` (`diff -rq` identical). `package.json`, `src/`, `assets/` untouched.
- Version note: deployed `package.json` still says **0.1.115** while `dist/` is **0.1.117 + ask->block**. Identify the running build by sha256 of `dist/cli/bin.mjs`, not by version.
- Rollback (one command):
  `D=~/.claude/plugins/marketplaces/fusengine-plugins/plugins/node_modules/@fusengine/harness; mv "$D/dist" ~/.Trash/harness-dist-new-2026-11-11 && cp -Rp "$D/dist.bak-2026-11-11-0115" "$D/dist"`

## (a) Deployed-binary replay (bun, HOME isolated per process, fresh session_id, real payload cwd)

| Case set | Host | Expected | Observed | Result |
|---|---|---|---|---|
| 16-case corpus (replay.ts) | claude-code | 11 ask / 3 deny / 1 allow / 1 deny (code) | identical, 16/16 | PASS |
| same 16 | codex, kimi, cursor | ask downgrades to deny by design (no interactive approval); deny cases deny | identical to source (see next row) | PASS (equal to source) |
| 86-row differential, full stdout + exit code, deployed vs source candidate | claude-code / codex / kimi / cursor | equal | 86/86 each, 344/344, 0 differences | PASS |

Notes: the first differential run showed a spurious `bun test` / cursor "project lesson" difference caused by my harness running the deployed binary with a different process cwd; rerun with identical cwd = 0 differences. Deployed verdict distribution (claude-code): 21 deny, 41 ask, 24 allow.

## (b) Real `claude -p` runs (Tier A: real tool, deployed dist, hook HOME isolated, only the test hook loaded: `hooks_started` = 1 per Bash call)

| Case | Command / action | Expected | Observed (hook decision from real transcript) | Result |
|---|---|---|---|---|
| A1 | `printf 'x' > notes.txt` | deny literal | deny `[BLOCKED] Bash write of literal text ... use the Write tool` ; file not created | PASS |
| L1 | same, then model told to follow the block | deny, then model uses Write | deny, then model called Write (allowed), Read shows `hello` | PASS |
| A2 | `echo hi > out.md` | deny | deny literal | PASS |
| O1 | owner command `cd <proj> && printf ... >> MEMORY.md && tail -2 MEMORY.md` | deny | deny `Bash write of literal text ... Edit tool to append to MEMORY.md` | PASS |
| T1 | `git status > /tmp/fh-rt-status.txt` | allow | allow, file created | PASS |
| T2 | `ls > /tmp/fh-rt-list.txt` | allow | allow, file created | PASS |
| T3 | `date > /tmp/fh-rt-date.txt` | plan said allow | ask (`date` is not in the producer/reader allowlist; same verdict from source) | NOTE: plan expectation wrong, not a regression |
| D1 | `printf 'export const b=2' > b.ts` | deny | deny `Bash write to code file` | PASS |
| D2 | `echo x > src/a.ts` | deny | deny `Bash write to code file` | PASS |
| C1 | `printf x > /dev/tty` | ask | ask | PASS |
| C3 | `printf x > errlink` (symlink to /dev/stderr) | ask | ask (Claude Code itself then refused: symlink outside working dirs) | PASS |
| C4 | `printf x > fifo` | ask | ask | PASS |
| N1-N3 | `ls`, `git status`, `cat package.json` | allow | allow, normal output | PASS |
| N4 | `ls \| sed -E 's/a/b/Ig'` | allow | allow (0.1.115 also allow in replay) | PASS |
| E1 | Edit tool on non-code `notes.txt` | allow | allow, file changed (hello -> world) | PASS |
| W1 | Write tool `src/ok.ts` (code) in isolated state | n/a | deny by APEX gate "explore + research required" (existing gate, no prior explore in that isolated session) | NOTE, unchanged behaviour |
| P1 | `cp /tmp/fh-rt-status.txt t.ts` | plan 3b: deny (F1) | **allow**, t.ts created | pre-existing hole (see below) |
| P2 | `mv /tmp/fh-rt-list.txt t2.ts` | plan 3b: deny (F1) | **allow**, t2.ts created | pre-existing hole (see below) |

All hook processes exited 0 (no crash). Evidence: `.../scratchpad/install-rt/rt/run-<id>.jsonl`, `debug-<id>.log`, `replay16.dep.out`, `diffdep2.out`.

### Before / after (direct replay, claude-code, same inputs)

| Command | 0.1.115 (backup) | deployed |
|---|---|---|
| `printf x > notes.txt` | ask | deny (literal text) |
| `ls > /tmp/x`, `git status > /tmp/x` | **ask** (not deny) | allow |
| `date > /tmp/x` | ask | ask |
| `printf 'export const b=2' > b.ts` | deny | deny |
| `cp /tmp/x t.ts`, `mv /tmp/x t2.ts` | allow | allow |

### Classification: pre-existing hole, coupling required before release
`cp`/`mv` from /tmp into a code file is allowed on 0.1.115 as well (Write to /tmp then `cp`). ask->block opens no new path to a code file, so no rollback. Per plan rule 3b, the release must ship the temp-output permission only together with the cp/mv/ln rule (f1-mono). That rule is **not in this build**.

## Hosts
- Kimi: not run. Installed Kimi harness is 0.1.110 (not this build) and `kimi -p` would write into `~/.kimi-code`, outside the allowed write path; an isolated run needs a credential copy. Adapter replay only (above).
- Codex: not run (credential copy needs the owner). Adapter replay only.
- Cursor: not logged in; adapter replay only.
- Fixes F1-F6 and FA: not in this build.

## Residues (not deleted)
`du -sh "$TMPDIR"` 14G (shared with other agents), `/private/tmp` 2.8G; own scratch `.../scratchpad/install-rt` 1.4G (about 1459 empty HOME dirs). Small leftovers: `/tmp/fh-rt-status.txt`, `/tmp/fh-rt-list.txt`, `/tmp/fh-rt-date.txt` (not created), symlinks `/tmp/fh-replay-L-82441`, `/tmp/fh-diff-L-83101`, `/tmp/fh-diff-L-87310`.

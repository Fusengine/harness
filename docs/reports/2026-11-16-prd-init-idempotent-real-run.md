# PRD `init` idempotent: real-condition run, 2026-11-16

Branch `fix/prd-init-idempotent` (uncommitted worktree `fuse-harness-wt-prdinit`). n=1. No `src/` change, no commit, nothing written outside the scratchpad `realrun-path/` and this report. `~/.codex` untouched.

## Wiring

`build-init.sh` builds the worktree (package.json `build` entries, `--dts` dropped, `--out-dir` redirected to `realrun-path/dist-init-build`; worktree not written) and the result replaces `dist` of the disposable `CODEX_HOME` (`node_modules/@fusengine/harness`); the previous dist (0.1.122 line, prdpath fix) is kept as `dist-v2/`. Proof: `grep -rl 'prd init: exists'` = 1 file in the new dist, 0 in `dist-v2/`; the new dist still holds the prdpath deny string (`write your PRD report to`, 1 file). Installed Codex hooks call `bun "${CODEX_HOME}/.../dist/cli/bin.mjs"`. Clean env (`env -i HOME PATH SHELL ZDOTDIR=<empty> CODEX_HOME FUSE_HARNESS_MARKETPLACES`), `FUSE_PRD=1` only via the project `.env`, fresh project `proj-prd-j` (init fixture, no remote), `runp.sh`, prompt `prompt-j.txt`.

Scenario: the lead runs `prd init --id codex --task utilities`, writes the task PRD (2 `typescript-expert` slots), spawns 2 executors; after they reported, a `sniper` prints sha256 of router, task PRD and `agents/*.json`, re-runs the same `prd init`, reprints the sha256. Then the lead validates. Wall 291 s, exit 0.

## Results

| # | Check | Result | Decisive evidence |
|---|---|---|---|
| 1 | First init (lead, rollout role `lead`) | PASS | `prd init: created <P>/.codex/apex/prd.json with task "utilities"` + `prd init: agent reports go in <P>/.codex/apex/prd/agents/<agent>-prd.json (absolute path - never <project>/prd/agents/)`, exit_code 0 |
| 2 | Second init by another agent in the run (role `sniper`, after executors reported) | PASS | `prd init: exists <P>/.codex/apex/prd.json with task "utilities"` + the same agents line, `exit_code 0` |
| 3 | In-run sha256 before/after the sniper's init | PASS | The 4 files' hashes each appear twice, identical: `23f353a1...` (typescript-expert report), `ef90f1c6...` (-2 report), router `5d2cab49...`, task PRD `a4dd05f7...` |
| 4 | My own 3rd init after the run (`third-init.sh`) | PASS | Output `prd init: exists .../proj-prd-j/.codex/apex/prd.json with task "utilities"` + agents line, rc 0. sha256 and mtime of router `0746dfd9...`, task PRD `8db0bbcf...`, reports `23f353a1...`, `ef90f1c6...` identical before/after; `ls -R .codex/apex` entry count 10 before and after (nothing created) |
| 5 | Reports location | PASS | `.codex/apex/prd/agents/typescript-expert-prd.json`, `typescript-expert-2-prd.json`; `proj-prd-j/prd` does not exist |
| 6 | Validation | PASS | `prd status`: `utilities validated 2 2/2 0`; `prd validate utilities` rc 0 (also rc 0 inside the run); 6 tests pass |
| 7 | PRD denials in the run | none | 0 `[BLOCKED] PRD` in the stream |

Note on hashes: in-run router/task hashes (`5d2cab49...`, `a4dd05f7...`) differ from my post-run ones (`0746dfd9...`, `8db0bbcf...`) only because the lead's `prd validate` ran between the sniper's init and my snapshot (validate stamps `validated-at`, mtime 1794843576 on both files); each pair is stable across its own init.

## Codex-port claim "repeated `created`" (read-only check on `realrun-prd/codex-home/sessions`)

Method: unique `call_id` of real `custom_tool_call` events whose input runs `bin.mjs ... prd init` (not copies of forked history: each such `call_id` occurs in exactly 1 rollout file), then the matching `custom_tool_call_output`.

| Project | Unique executed `prd init` calls | Outputs |
|---|---|---|
| proj-prd-c | 2 | 1 `prd init: created`, 1 `Script failed` (no init output) |
| proj-prd-d | 1 | `created` |
| proj-prd-e | 1 | `created` |
| proj-prd-f | 1 | `created` |
| proj-prd-g | 2 | 1 `created` (call `call_151f...`); the other (`call_4ff1...`) never ran: `Command blocked by PreToolUse hook: [BLOCKED] Bash file write` |
| proj-control-f / -g | 1 each | `prd init requires FUSE_PRD=1` (control) |

Result: no project shows two real `created` outputs. The strings `router already present` found in the proj-prd-g rollouts are doctrine text read from the lead-orchestration skill ("PRD mode is on only if `init` prints `created ...` (or `router already present` ...)"), not exec output. So the "repeated `created`" is not supported by these rollouts; the genuine second `init` behaviour (router already present) was only observable here, where the new `exists` output was exercised twice (sniper, me).

## Cost / not verified

- Wall 291 s; Codex cost not measured.
- Not verified: a second init racing with an executor mid-write (the sniper ran after reporting; the lead-sequenced order was enforced by the prompt), `exists` when the router exists but the task PRD file does not, other hosts, n=1.
- Earlier noted slip: one `rm -f /tmp/dummy` on a zero-byte file I created by mistake in a previous mandate; nothing deleted in this one.

Artifacts: `/private/tmp/claude-501/-Users-brunoazoulay-Labo-docker-lab-dev-local-Dev-ai-claude-code-fuse-harness/a5af2a9f-7ce7-4a24-a606-ba69f9397668/scratchpad/realrun-path/` (`build-init.sh`, `prompt-j.txt`, `third-init.sh`, `proj-prd-j/`, `logs/proj-prd-j.jsonl`, `dist-init-build/`, `dist-v2/`).

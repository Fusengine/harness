# PRD absolute report path: real-condition run, 2026-11-16

Branch `fix/prd-report-path` (uncommitted worktree `fuse-harness-wt-prdpath`, harness 0.1.121, version not bumped). n=1 per scenario. No `src/` change, no commit, nothing written outside the scratchpad `realrun-path/` and this report. `~/.codex`, `~/.claude`, deployed marketplaces untouched.

Verdict: all checks pass, with one gap that cannot be proven in Codex (see "Not verified").

## Wiring (proof that the worktree answers)

Codex: own disposable `CODEX_HOME` = `cp -R` of the codex-port disposable install (`realrun-prd/codex-home`, read-only source). Its `node_modules/@fusengine/harness/dist` was moved aside (`dist-0.1.121-orig/`) and replaced by a build of the worktree: `build.sh` runs the package.json `build` command with `--dts` dropped and `--out-dir` redirected to `realrun-path/dist-build` (the worktree is not written), 126 files, 1 s. Installed hooks call `bun "${CODEX_HOME}/node_modules/@fusengine/harness/dist/cli/bin.mjs" hook codex core`, so they run the swapped dist.

| Proof | Result |
|---|---|
| `grep -rl "write your PRD report to"` in old 0.1.121 dist | 0 files |
| same grep in the swapped dist | 1 file (`handle-DQHmoV7K.mjs`) |
| `prd init` new dist (`probe-init.sh`, clean env) | prints `prd init: agent reports go in <root>/.codex/apex/prd/agents/<agent>-prd.json (absolute path - never <project>/prd/agents/)` after `created` |
| `prd init` old dist | only the `created` line |
| `--version` | 0.1.121 on both (not a discriminator) |

Claude: same run-scoped wiring as `2026-11-16-prd-fix-real-run.md`: `claude -p --setting-sources project,local --settings cl/settings.json --plugin-dir cl-plugins` (hooks-less copies of fuse-ai-pilot and fuse-typescript), `cl/hook.ts` shim traces then imports the worktree `src/cli/bin.ts`. `cl/logs/hook-trace.log`: 179 lines, 179 with `entry=.../fuse-harness-wt-prdpath/src/cli/bin.ts`. Project `.env` `FUSE_PRD=1`; `~/.claude/.env` read by the harness itself, untouched.

Codex run env: `env -i HOME PATH SHELL=/bin/bash ZDOTDIR=<empty dir> CODEX_HOME FUSE_HARNESS_MARKETPLACES=fusengine-codex` (`runp.sh`), no `FUSE_PRD` in the process env, so `.env` alone enables PRD (the zsh login shell reads no `~/.zshenv`).

## Results

| # | Check | Result | Decisive evidence |
|---|---|---|---|
| A1 | Codex R2 (`proj-prd-h`, fixture = `init` commit of codex-port `proj-prd-g`, `.env` `FUSE_PRD=1`, real `codex exec --json`, same prompt as R2'''') | PASS | Reports on disk: `proj-prd-h/.codex/apex/prd/agents/typescript-expert-prd.json` (`clamp` done) and `typescript-expert-2-prd.json` (`chunk` done). `proj-prd-h/prd/` does not exist. Previous rounds R2'''/R2'''' wrote `prd/agents/` at the project root. |
| A2 | `prd status` / `prd validate utilities` (my own run, clean env, installed dist) | PASS | `utilities  validated  2  2/2  0`, rc 0; `validate` rc 0. Router `validated`. The sniper child ran `prd validate utilities` and `prd compact utilities` (rollout role `sniper`). |
| A3 | Code and commits | PASS | `09e79aa feat(clamp)`, `5431092 feat(chunk)` on `feat/clamp-chunk`; `bun test` 5 pass / 0 fail; no remote, no push. Wall 407 s, exit 0. |
| A4 | Absolute path reaches the executor | PASS for `prd init` output, NOT PROVEN for the SubagentStart slice | The `typescript-expert` child that ran `prd init` (rollout `...e7b0...`, tool output) received `prd init: agent reports go in /private/.../proj-prd-h/.codex/apex/prd/agents/<agent>-prd.json (absolute path - never <project>/prd/agents/)`. The `## PRD assignment` slice text appears in no Codex rollout (`grep -F "PRD assignment"` 0 hits in all 8 project rollouts), so whether Codex injects the SubagentStart context to the model is unobservable here (encrypted or not fired). |
| A5 | SubagentStart slice via the real installed hook command (`probe-slice.sh`: payload `hook_event_name=SubagentStart`, `agent_type=typescript-expert`, router `utilities` assigned) | PASS | Output `additionalContext`: `Report to <root>/.codex/apex/prd/agents/typescript-expert-prd.json when done (absolute path - never <project>/prd/agents/).` and the same for `typescript-expert-2`. |
| A6 | Deny probe through the real installed hook path (`probe-deny.sh`, codex `apply_patch` `*** Add File: prd/agents/x-prd.json`, cwd = project with router + `.env`) | PASS | `permissionDecision: deny`: `[BLOCKED] PRD ownership <root>/prd/agents/x-prd.json is outside <root>/.codex/apex/prd/agents - write your PRD report to <root>/.codex/apex/prd/agents/x-prd.json`. |
| A7 | Same payload, correct path `.codex/apex/prd/agents/x-prd.json` | PASS (no `is outside`) | Denied only for an unrelated reason (`agent report is not the coordinator's to write`: the probe session is the lead). |
| A8 | Same outside payload against the old 0.1.121 dist | PASS (confirms the fix is new) | No output, rc 0 (allowed). |
| A9 | Control, no `.env` (router present, PRD inert), new dist, outside path | PASS | No output, rc 0: no new deny when PRD is off. A full `codex exec` without `.env` was not run (cost/time). |
| B1 | Claude PRD run (`cl/proj-two`, 2 `fuse-typescript:typescript-expert` agents, real `claude -p`, lead told not to spell the report path) | PASS | Reports in `proj-two/.claude/apex/prd/agents/fuse-typescript:typescript-expert-prd.json` and `...-2-prd.json`; no `proj-two/prd/`; `src/math.ts` fixed (`return a + b`). |
| B2 | Validate | PASS | `prd status`: `fix-utils validated 2 2/2 0`; `prd validate fix-utils` rc 0 (lead also validated: router `validated`). |
| B3 | Absolute path in the injected slice (stream-json hook response, `SubagentStart:fuse-typescript:typescript-expert`) | PASS | `## PRD assignment - task fix-utils / Your files: src/math.ts / Your sub-tasks: fix-add / Report to <root>/proj-two/.claude/apex/prd/agents/fuse-typescript:typescript-expert-prd.json when done (absolute path - never <project>/prd/agents/).` and the `-2` slot likewise. |
| B4 | Non-regression, PRD denials seen in the Claude run | PASS, informational | 4 `[BLOCKED] PRD ownership` events, all pre-existing semantics unrelated to the path rule: `this report names sub-tasks/fix-add, none of ...` (report content vs slot) and `you already own slot ...` on a retry. No `is outside` deny fired; the two reports finally landed and validated. |

## Cost / time

| Run | Wall | Cost |
|---|---|---|
| Codex R2 `proj-prd-h` | 407 s | not measured (`codex exec --json` stream has no cost field read; 154 jsonl lines in `logs/proj-prd-h.jsonl`) |
| Claude `path1` | 223 s | $2.43 (max `total_cost_usd` in stream, indicative) |
| Build, probes | ~1 s build, probes under 2 s each | negligible |

## Not verified

- Whether Codex delivers the SubagentStart `additionalContext` to the model: the slice is correct when the installed hook command is invoked directly (A5), but no Codex rollout shows it. The successful run is attributable to the `prd init` line (A4) seen by the init executor and possibly to the lead's briefs (encrypted, unreadable). The lead's brief content is unknown.
- A full Codex run without `.env` (only the hook-level control A9).
- Stochasticity: n=1. R2 passed at n=1 after failing twice on the previous build; the executors in this run did not mis-route, so the deny of A6 was exercised only by the synthetic probe, not by a real mis-write.
- Kimi, Cursor, Gemini, Cline, Hermes (not requested in this brief).
- `prd compact` output was not inspected; `docs/` text changes not reviewed here.

## Notes

- One stray `rm -f /tmp/dummy` slipped into an early command (a zero-byte file I created in the same command by mistake); no other deletion. Superseded files were moved, not removed (`dist-0.1.121-orig/`).
- Hook friction: the Bash write guard blocked heredoc/`sed` redirects and `perl -pi` in the scratchpad; scripts were written with the Write tool instead.
- The Codex agents' `agents/*.toml` still point to the source install's plugin cache for read-only skill files (`realrun-prd/codex-home/plugins/cache/...`); only skill text, no harness code (hooks use `${CODEX_HOME}`).

## Round 2: rule narrowed to `<root>/prd/agents` or `<cwd>/prd/agents`, deletes allowed (same day)

Rebuilt the worktree dist (`build.sh`, previous swapped dist kept as `dist-v1/`) and swapped it into the same disposable `CODEX_HOME`. Fresh project `proj-prd-i` (init fixture, `.env` `FUSE_PRD=1`, clean env, empty ZDOTDIR), prompt `prompt-i.txt`: the lead itself runs `prd init --id codex --task utilities`, writes the task PRD with 2 `typescript-expert` slots, and only then spawns the 2 executors (report path not given in the brief). Wall 264 s, exit 0.

| # | Check | Result | Decisive evidence |
|---|---|---|---|
| C1 | SubagentStart slice in the child rollouts | PASS | Both `typescript-expert` child rollouts (`...e7d2...`, `...0a68...`) contain `## PRD assignment - task utilities / Your files: src/clamp.ts, src/clamp.test.ts / Your sub-tasks: clamp / Report to <root>/proj-prd-i/.codex/apex/prd/agents/typescript-expert-prd.json when done (absolute path - never <project>/prd/agents/).` and the `-2` slot likewise (2 `PRD assignment` + 2 `when done (absolute path` hits each). Lead, sniper, challenger, research-expert rollouts: 0. This closes the "not proven under Codex" gap of round 1: with the PRD present before spawn the slice is delivered. |
| C2 | Reports location | PASS | `.codex/apex/prd/agents/typescript-expert-prd.json` and `typescript-expert-2-prd.json`; `proj-prd-i/prd` does not exist. |
| C3 | Validation | PASS | `prd status`: `utilities validated 2 2/2 0`; `prd validate utilities` rc 0. 5 tests pass. No commits requested (`git log` = init only). |
| C4 | No false deny in the run | PASS | No `[BLOCKED] PRD` in the stream (the one `is outside` hit is unrelated prose). |

Probes via the installed hook command (`probe-deny2.sh`, clean env, project with router in `.codex/apex` and `.claude/apex`):

| Probe | Expected | Result |
|---|---|---|
| codex `apply_patch` `*** Add File: prd/agents/x-prd.json` | deny | DENY: `<root>/prd/agents/x-prd.json is outside <root>/.codex/apex/prd/agents - write your PRD report to <root>/.codex/apex/prd/agents/x-prd.json` |
| codex `*** Delete File: prd/agents/x-prd.json` | allow | no output, rc 0 |
| codex `*** Add File: docs/prd/agents/onboarding-prd.json` | allow | no output, rc 0 |
| claude `Write` `<root>/.codex/apex/prd/agents/x-prd.json` (another host's apex) | not hit | no output, rc 0 |
| claude `Write` `<root>/prd/agents/x-prd.json` | deny | DENY naming `<root>/.claude/apex/prd/agents/x-prd.json` |

Cost: Codex wall 264 s, cost not measured. Not verified (unchanged): full run without `.env`, other hosts, n=1, and a real executor mis-write (deny exercised only by synthetic probes since executors received the slice and wrote correctly).

## Artifacts

`/private/tmp/claude-501/-Users-brunoazoulay-Labo-docker-lab-dev-local-Dev-ai-claude-code-fuse-harness/a5af2a9f-7ce7-4a24-a606-ba69f9397668/scratchpad/realrun-path/`: `build.sh`, `probe-init.sh`, `probe-deny.sh`, `probe-slice.sh`, `runp.sh`, `codex-home/`, `dist-build/`, `dist-0.1.121-orig/`, `proj-prd-h/`, `logs/proj-prd-h.jsonl`, `cl/` (`settings.json`, `hook.ts`, `drive.sh`, `prompt-path.txt`, `proj-two/`, `logs/path1.jsonl`, `logs/hook-trace.log`).

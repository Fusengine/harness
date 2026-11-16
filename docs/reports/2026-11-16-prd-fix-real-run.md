# PRD fix — real-condition run (worktree harness) — 2026-11-16

Branch `fix/prd-bootstrap-resume` (uncommitted worktree). Reproduces the scenario of `claude-plugins/docs/reports/2026-11-16-prd-real-run.md` with the fixes. Real `claude -p` (Claude Code 2.1.325), Opus lead, 4 `fuse-typescript:typescript-expert` sub-agents, stream-json logs. n=1 per scenario.

Verdict: **A, B, C, D, E all pass.** The three failures of the previous report (bootstrap deadlock, resume deadlock, completion-order dependence) did not reproduce.

## How the worktree harness was wired (no global file written)

The hooks that fire in a stock session are the installed marketplace hooks (`~/.claude/settings.json` -> `hooks-loader.ts` -> plugin `hooks.json` -> installed harness 0.1.120, old PRD logic). Run-scoped replacement, per `claude -p` process, all under the scratchpad `realrun/`:

| Flag | Effect |
|---|---|
| `--setting-sources project,local` | drops the user settings source: no `hooks-loader.ts`, no `enabledPlugins`, so no marketplace plugin and no installed-harness hook is loaded |
| `--settings realrun/settings.json` | declares the same hook entries as `core-guards/hooks/hooks.json` (15 events) + `fuse-ai-pilot/hooks/hooks.json` (`aipilot` scope), with the harness path swapped for `realrun/hook.ts`; `env` (agent teams, fork subagent, subagent model sonnet) and `model: opus` copied from user settings |
| `--plugin-dir realrun/plugins` | copies of the cached `fuse-ai-pilot` 1.2.54 and `fuse-typescript` 1.0.12 plugins with `hooks/` removed, so the agents (`fuse-typescript:typescript-expert`, explore/research/sniper) exist but add no installed-harness hook |

`realrun/hook.ts` appends one trace line then `await import(".../fuse-harness-wt-prd/src/cli/bin.ts")`: the unchanged worktree CLI (argv `hook claude-code [scope]`, same `--env-file` quiet wrapper on `Stop[1]`). `~/.claude/.env` (FUSE_PRD=1) is read by the harness itself, untouched. `FUSE_HARNESS_SOUND=0` set on the command line.

Proof that the worktree is the one answering:

1. Smoke run `init` event: `plugins` = `fuse-ai-pilot@inline`, `fuse-typescript@inline` + builtins only (no `@fusengine-plugins` entry). Hook events fired: SessionStart, UserPromptSubmit, Pre/PostToolUse:Bash, Stop x2 = trace lines 1:1 (`logs/hook-trace.log`, 418 lines over all runs, each with `entry=.../fuse-harness-wt-prd/src/cli/bin.ts`).
2. `harness prd init` exists only in the worktree: installed `bin.mjs prd init` -> `harness prd: unknown sub-command "init" (expected status|validate|compact)`; worktree -> runs. (`--version` prints 0.1.120 on both: the worktree is not bumped, so version is not a discriminator.)
3. Negative probe through the real hook shim (`realrun/probe-deny.ts`, synthetic PreToolUse Write by a fresh `agent_id` onto an already-complete slot of `proj-order`) returned `permissionDecision: deny`:
   `[BLOCKED] PRD ownership ... slot "fuse-typescript:typescript-expert-2" is already reported complete — a new agent cannot rewrite it; claim a slot that is still open`.
   That string exists only in `src/policy/prd/prd-claim.ts`; `grep -r "already reported complete"` on the installed `dist/` = 0 hits. The old wording `name doesn't match your agent_type, or already bound to another agent` is the installed one.

Residual difference vs a stock session: the real session also loads ~25 other marketplace plugins' hooks (loader-only/scoped); not replicated (only core + aipilot scopes). The `fuse-typescript` plugin's own `hooks.json` (identical `Write|Edit` / PostToolUse core command) is covered by the core entries.

## Results

| Step | Result | Proof |
|---|---|---|
| A. Bootstrap (`prd init`, then lead Writes task PRD) | **PASS** | Lead ran `FUSE_PRD=1 bun <wt>/src/cli/bin.ts prd init --task fix-utils --id claude-code --root <proj>` -> `prd init: created <proj>/.claude/apex/prd.json with task "fix-utils"`, `exit 0`; then `Write .claude/apex/prd/fix-utils-prd.json` -> `File created successfully` (keys `fuse-typescript:typescript-expert`, `-2`, `-3`, `-4`). Zero `Protected path` / `PRD ownership` denials in `prd1.jsonl`. |
| B. Run 1, killed after 2 reports | **PASS** | killed at 79 s with 2 reports on disk (`typescript-expert-prd.json` 04:23:20, `-2-prd.json` 04:23:22; `math.ts` and `str.ts` fixed; `list.ts`/`date.ts` untouched 04:22:01). `harness prd status`: `fix-utils  assigned  4  2/4  0`, exit 0. Both agent report Writes allowed, one per slot. |
| C. Resume, fresh session | **PASS** | New session id (`67484847…` -> `0c54c211…`). Lead read docs + `prd status` (`2/4`), relaunched only `fix-sum` and `fix-year`; their report Writes `…-3-prd.json` and `…-4-prd.json` -> `File created successfully` (the exact case that was denied before). No PRD denial in the log. `math.ts` mtime 1794799394 and `str.ts` 1794799399, both reports 1794799400/1794799402: unchanged. Final: `harness prd status` -> `fix-utils  validated  4  4/4  0` (exit 0); `FUSE_PRD=1 harness prd validate fix-utils` -> no output, **exit 0**; router: `status: "validated"`, `validated-at` set. Disk: all 4 functions correct. The lead-Stop hook also fired the compact hint: `PRD task "fix-utils" is fully validated and ready to compact. Run harness prd compact fix-utils.` (lead-Stop wiring works on claude-code). |
| D. Order independence | **PASS** | Separate run (`proj-order`): agent-str wrote `…typescript-expert-2-prd.json` FIRST (exact slot unclaimed), allowed; agent-math then wrote `…typescript-expert-prd.json`, allowed. Router/tasks validated by the lead (`validated-at 03:24:51Z`), my `prd status`: `order-test  validated  2  2/2  0`. No PRD denial. |
| E. Control (no router, project `.env` `FUSE_PRD=0`) | **PASS** | 4 agents `agent-math/str/list/date`, all 4 files fixed on disk, no `.claude/` dir created, 0 `[BLOCKED] PRD`, 0 `Protected path` (only unrelated: one `Brief without the owner's words` block). |

## Cost / time

| Run | Wall | Tool calls (lead / total) | Cost (max `total_cost_usd` in stream) |
|---|---|---|---|
| A+B run 1 (killed at 2 reports) | 80 s | 15 / 32 | $0.87 (partial: killed) |
| C resume (fresh session, 2 agents) | 81 s | 8 / 18 | $0.86 |
| D order test (2 sequential agents) | 167 s | 17 / 30 | $1.54 |
| E control (4 agents, no router) | 116 s | 12 / 33 | $1.54 |
| Smoke (wiring) | 9 s | 1 / 1 | $0.36 |

PRD interrupt+resume total (B+C): 161 s, $1.73 vs control 116 s, $1.54. Not directly comparable with the previous report (different prompt/agent counts, and `total_cost_usd` may not include every sub-agent's spend; stream has several `result` events per run, the max is used).

## Findings (not fixed — no code change per mandate)

1. **`prd init` in a project without a `.claude/` (or other harness home) dir fails**: `no harness home directory under <root> — pass --id <harness>`, exit 2. The lead hit it once and recovered with `--id claude-code` (`logs/prd1.jsonl`). `docs/prd.md` step 1 shows `prd init --task auth-refactor --root <project>` without `--id`; in a fresh throwaway project it does not work as documented. Suggestion: document `--id`, or default to `claude-code` when run from Claude Code / create the home dir. Real projects normally already have `.claude/`.
2. Lead's first `cd "$PWD"; H="bun …"; $H prd init` form was blocked by `[CONFIRM] Command cannot be analysed` (dynamic command): expected, unrelated to PRD.
3. `prd validate` is idempotent: running it again on a validated task re-stamps `validated-at` (observed 03:25:09Z lead, 03:25:42Z operator). Harmless.

## Not verified

- Block-once on `SubagentStop` and cross-check violation on lead `Stop` (no violation was induced); `harness prd compact` was not run.
- Behaviour with all ~25 marketplace plugin hooks loaded together (only core + aipilot scopes were replicated).
- Whether a project `.env` `FUSE_PRD=0` overrides the global `FUSE_PRD=1` (control is inert because no router exists, same caveat as the previous report).
- Cost totals are indicative; single sample per scenario.

## Artifacts

Scratchpad `/private/tmp/claude-501/-Users-brunoazoulay-Labo-docker-lab-dev-local-Dev-ai-claude-code-fuse-harness/a5af2a9f-7ce7-4a24-a606-ba69f9397668/scratchpad/realrun/`: `settings.json`, `hook.ts`, `gen-settings.ts`, `drive.sh`, `prompt-*.txt`, `probe-deny.ts`, projects `proj-prd` (A–C), `proj-order` (D), `proj-ctl` (E), `proj-smoke`, logs `logs/{smoke,prd1,prd2,order,ctl}.jsonl(+.meta)` and `logs/hook-trace.log`. No repo, plugin, harness, `~/.claude`, `~/.claude/.env` or marketplace file was modified; no commit; no `pkill` (killed run 1 with `kill -TERM <pid>`; no leftover process). The harness itself writes its normal session state under `~/.fuse-harness` during hooks, as in any session.

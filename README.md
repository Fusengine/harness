# @fusengine/harness

A **governance layer for AI coding agents**: gates backed by cited evidence
(not vibes), a decision-time lesson memory, verification receipts, and a
one-shot gate metric — ported from a Claude Code plugin into one **Bun-native**
npm package. The policy core is harness-agnostic; how much of it actually
*enforces* depends on the harness's own hook system — see the
[compatibility matrix](#compatibility) below before assuming parity across harnesses.

```
detect → init (writes that harness's hook wiring) → `harness hook` → guards + APEX gates → native deny/ask/context
```

## Install

```sh
npm i -g @fusengine/harness     # for the CLI (harness init/hook/check)
# or, as a library:
bun add @fusengine/harness      # Bun reads the TS source directly — no build step
```

## Quickstart

```sh
cd your-project
harness init                              # detects the harness, writes its pre+post hook wiring
export FUSE_HARNESS_MARKETPLACES=fusengine-plugins   # (optional) which marketplaces to auto-scan
export FUSE_HARNESS_REFS=.claude/skills              # (optional) explicit refs dir, overrides auto-discovery
```

`init` writes the wiring file for the detected harness (`.claude/settings.json`,
`.codex/hooks.json`, `.cursor/hooks.json`, `.gemini/settings.json`, or
`.clinerules/hooks/PreToolUse`+`PostToolUse`) — for Claude Code, Codex, Cursor,
Gemini CLI and Cline this covers **PreToolUse + PostToolUse only**
(`src/init/templates.ts`); Hermes has no `init` runner because its config lives
outside the project at `~/.hermes/config.yaml` (`src/adapters/hermes/index.ts:3-4`).
The richer lifecycle (SessionStart, SubagentStart/Stop, Stop, PreCompact/PostCompact,
TaskCompleted, TeammateIdle, PostToolUseFailure, InstructionsLoaded — 14 distinct
Claude Code hook events in total, `src/runtime/lifecycle/dispatch.ts` +
`src/runtime/handle.ts:56-80`) is **implemented** in the runtime but only fires
when something wires those extra hook events into `.claude/settings.json` — either
by hand, or via the fusengine-plugins marketplace this repo is itself developed
under (its ~11 sibling plugins each add their own event, `src/runtime/burst-window.ts:5-11`).

**Where state lives** (two separate roots — this changed across 0.1.34→0.1.51,
don't assume either the old or the "everything in one place" story):

- Session track, deny-loop/one-shot sidecars: **out-of-tree**, under
  `~/.fuse-harness/state/<8-char-md5-of-project-path>/` (`src/runtime/paths.ts:5-6,41-43`) —
  deliberately outside the repo so the protected-path guard never has to bless
  writes to its own enforcement state.
- MCP/WebFetch response cache and the curated `MEMORY/LESSON.md`-equivalent lessons
  file: still **in-tree**, under `<project>/.harness/{cache,memory}`
  (`src/config/layout.ts:15-26`) — `.harness/` is gitignored except
  `memory/LESSON.md`, which is meant to be committed (`STATE_GITIGNORE`,
  `src/config/layout.ts:10`).

### CLI

| Command | What it does |
|---------|--------------|
| `harness init [id]` | Write the pre+post hook wiring for the detected (or named) harness. |
| `harness hook <id>` | Runtime: read a hook payload on stdin, gate (pre) or record (post), print the native response. (Hooks call this — you don't.) |
| `harness check` | cli-mode: check staged files in a pre-commit step, exit non-zero on a violation. For harnesses without hooks. |
| `harness doctor` | Print the version + resolved path of the harness *actually executing*, and compare it to npm's latest — the fast way to catch a stale global (see Pinning). |
| `harness --version` | Print the running version (bare, on stdout) and exit. |
| `harness codex-rules [--out <path>]` | Generate the Codex execpolicy rules file (Starlark) from the security patterns; stdout or `--out`. Plain `rm` has no prompt rule (the hook gates it with a CONFIRM code); see [docs/adapters.md](docs/adapters.md#codex-exec-policy--harness-codex-rules). |
| `harness prd status [--json]` | Read-only, works without `FUSE_PRD=1`. Print each task's router status and sub-task progress. |
| `harness prd validate <task> [agent]` | Requires `FUSE_PRD=1`. Cross-check a task PRD against agent reports and promote matching sub-tasks/router entries to `validated`. |
| `harness prd compact <task>` | Requires `FUSE_PRD=1`. Collapse a fully-validated task PRD to its compacted shape. |

The [`motion` scope](docs/motion.md) adds owner-approved stills/draft gates for the motion render pipeline.

Every invocation writes a `@fusengine/harness vX.Y.Z` banner to **stderr** (never
stdout — the hook JSON contract stays clean) so you can see which version ran.

cli-mode (Aider / Windsurf / OpenHands), as a pre-commit step:

```sh
# .husky/pre-commit
npx harness check
```

### Pinning (required for hook consumers)

Any consumer `hooks.json` / `settings.json` that runs the harness via `bunx`
**MUST pin an exact version** — `@fusengine/harness@X.Y.Z` — never a range
(`^` / `~`) and never the bare or `@latest` spec:

```jsonc
// .claude/settings.json — correct: exact pin
"command": "bunx @fusengine/harness@0.1.56 hook claude"
// WRONG — may silently keep running a stale global install:
"command": "bunx @fusengine/harness hook claude"
```

**Why.** A still-open bun bug ([oven-sh/bun#5791]) makes an unpinned `bunx <pkg>`
prefer an already-installed **global** copy over npm-latest, and publishing a new
version updates neither that global nor the bunx cache (`bun pm cache rm` does
**not** remove the global). A hook wired without an exact pin can therefore keep
executing an old harness indefinitely after you publish a fix. Pinning `@X.Y.Z`
forces the exact version to resolve.

Run `harness doctor` to see which version is actually executing and whether npm
has a newer one:

```sh
harness doctor
# @fusengine/harness doctor
#   running:    0.1.56
#   package:    /Users/you/.bun/install/global/node_modules/@fusengine/harness
#   runtime:    /Users/you/.bun/bin/bun
#   npm latest: 0.1.57
#   ! stale — npm serves 0.1.57. Pin "@fusengine/harness@0.1.57" in hooks.json.
```

If `doctor` reports a stale global, clear it and re-pin:

```sh
bun remove -g @fusengine/harness && bun pm cache rm
```

[oven-sh/bun#5791]: https://github.com/oven-sh/bun/issues/5791

## Compatibility

**There is no "runs the same on any harness."** Each row is a real ceiling, not
a formatting nuance — read it before assuming a gate that works on Claude Code
also works elsewhere.

| Harness | PreToolUse coverage | Lifecycle (Session/Subagent/Stop/Compact/…) | Known limit |
|---|---|---|---|
| **claude-code** | Full: `evaluate` + APEX gates via `handleHook` (`src/adapters/claude/index.ts`) | 14 event types implemented (`dispatch.ts`) — fires once wired into `.claude/settings.json` beyond the `init` default | None found; richer lifecycle needs manual/marketplace wiring (see Quickstart) |
| **codex** | Bash gated reliably; **`apply_patch` edits are now gated too** — the patch text is parsed per file (`adapters/codex/apply-patch.ts`), each hunk runs the file gates and ONE violating hunk denies the whole patch (`runtime/apply-patch-gate.ts`, sim scenario 22 incl. the multi-file smuggling case). `ask` prompts are **downgraded to explicit deny** (`respond.ts`, sim scenario 23) because Codex fails open on unsupported shapes — the deny now carries a `CONFIRM <code>` recourse (see "CONFIRM code" under [Beyond gating](#beyond-gating-memory-receipts-one-shot-metric) below). On the PostToolUse side, an allowed patch is fanned into one synthetic per-file event so the SOLID/tracking/post-edit handlers see every touched file (`runtime/post-fanout.ts`), and a non-blocking security advisory fires on the first qualifying file (`securityAdvisoryForPatch`). | Not wired by `harness init codex` (PreToolUse `Bash\|apply_patch` + PostToolUse only, `src/init/templates.ts:29-38`) — `Stop` (session cleanup + the SOLID/receipt completion check, since Codex never emits `SessionEnd`/`TaskCompleted`, `runtime/lifecycle/stop-core.ts`) and `SessionStart` (plugin agents/commands cache resync, `runtime/lifecycle/codex-resync/`) ARE implemented but, same caveat as claude-code's extra lifecycle above, only fire once the codex-plugins marketplace's own `hooks.json` wires them. | Upstream caveat: Codex itself does not always enforce a correct `apply_patch` deny (openai/codex#27833) — we emit the right verdict; enforcement is theirs. No interactive `ask`. Codex has no native `PostToolUseFailure`; a failure is inferred from the ordinary `PostToolUse` result shape (non-zero exit or an explicit error field only — never a guess) and journaled into the one-shot failure tally (`src/tracking/codex-post-failure.ts`). |
| **cursor** | `beforeShellExecution` can deny/ask (shell only, `cursor/index.ts:16-21`) | none | File edits are **advisory only**: `afterFileEdit` always returns `allow` + a `user_message` correction on violation — a `deny` there has no proven effect (hook was "informational only" at launch, and Cursor's deny-enforcement for file ops is confirmed broken upstream, forum.cursor.com/t/154377). Human sees the message; the model is never re-informed. Platform ceiling, documented in `cursor/index.ts`. |
| **gemini-cli** | `BeforeTool` denies via `{decision:"deny",reason}` (`gemini/index.ts:22-36`) | none | Thin stateless adapter — no session track, no APEX gates wired through it. |
| **cline** | `PreToolUse` only; block → `{cancel:true}`, non-block → `contextModification` (`cline/index.ts:24-36`) | none | Same as gemini-cli: stateless guard only. |
| **hermes** | `pre_tool_call` proven: reuses the Claude stdin reader, blocks via `{decision:"block",reason}` (`hermes/index.ts:12-36`) | untested — no lifecycle dispatch wired for Hermes in this repo | `ask`/`inform` degrade to non-blocking `{context}` — Hermes "has no interactive ask state" (`hermes/index.ts:27-28`). |
| **kimi** | `PreToolUse` denies via the camelCase JSON channel `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` on stdout at **exit 0** (verified live against kimi-code v0.27.0 — exit 2 with stderr = reason also blocks, but is not required) — only `deny` is documented. `ask` is **downgraded to deny** prefixed `[downgraded from ask — Kimi Code has no interactive approval]`, with a `CONFIRM <code>` recourse appended (see "CONFIRM code" under [Beyond gating](#beyond-gating-memory-receipts-one-shot-metric) below); `inform` rides plain stdout text at exit 0, never wrapped in JSON. Blocking events: `UserPromptSubmit`, `PreToolUse`, `Stop` (`kimi/index.ts`). | Observation only: `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionResult`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `StopFailure`, `Interrupt`, `PreCompact`, `PostCompact`, `Notification` — Kimi delivers them but **ignores any response**, so no verdict can be returned from them. | A **hook** cannot request approval — Kimi's `ask` lives in a parallel, hook-unreachable system (`[[permission.rules]] decision = "ask"` in `config.toml`), hence the ask→deny downgrade. Hooks are configured **only** in the global `~/.kimi-code/config.toml` (no project-local hooks file), so `harness init` writes no kimi wiring — copy the TOML snippet from [docs/adapters.md](docs/adapters.md#kimi-code--manual-wiring), and emit **no field** beyond `event`/`matcher`/`command`/`timeout` or the whole config fails to load. **Fail-open by design**: any exit code other than 0/2, a timeout, or a crash lets the call through. Stdin payload is snake_case and carries only `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input.command` and an undocumented `tool_call_id` (unused here) — no `transcript_path`, no `permission_mode`, no `tool_response`. Verified live against kimi-code v0.27.0 for `PreToolUse`/`Bash`; validate hand-written config with `kimi doctor`. Instructions file is `AGENTS.md`, not `CLAUDE.md`. |

## What it enforces

Guard/gate chain evaluated before a tool runs (`src/policy/guards/index.ts`,
`src/policy/apex-gates.ts`, `src/policy/evaluate.ts`):

| Guard / gate | Fires on |
|---|---|
| security | `rm -rf /`, fork bombs, `curl \| sh`; `sudo` (asks); `ssh … \| sh` (asks) |
| confirm relay | a `CONFIRM <code>` relayed through a nested agent CLI (`codex exec`, `kimi -p`, `claude -p`, `npx …`, `tmux send-keys`, …) — every host |
| protected-path | edits to `.claude/plugins\|logs\|cache`, `.git/`, the harness's own state dirs |
| bash-write | `sed -i` / redirects to code files; literal-text `echo`/`printf`/heredoc/`tee` writes to non-code files (→ "use Write/Edit"); `cp`/`mv` of foreign content onto project code files; command output redirected to the scratchpad or system temp is allowed; `python3 -c` judged on content (mutating script → block, read-only → pass, same as `node -e`) |
| interface-separation | top-level interface/type/protocol in a component/controller |
| install | `npm/pip/brew/...` installs (asks) |
| git | destructive git (`push --force`, `reset --hard`, …) — block; routine git — ask |
| file-size (SOLID) | a code file over `FUSE_SOLID_MAX_LINES` (default 100) |
| APEX brainstorm | creating a new file without brainstorming (when flagged) |
| APEX freshness | `explore-codebase` + `research-expert` not run within the window |
| APEX doc-consulted | Context7 **and** Exa not consulted this session (a web-only fallback also passes) |
| APEX solid-read | required SOLID refs (auto-discovered, or `FUSE_HARNESS_REFS`) not read within the TTL |
| framework sub-skill | framework / shadcn / Tailwind code whose required skill wasn't read this session |
| Gemini MCP (opt-in) | hand-written Tailwind UI without a `mcp__gemini-design__*` call — only when `FUSE_ENFORCE_GEMINI_MCP` is set |
| MCP verbosity / cache | caps exa `numResults`; serves a fresh cached MCP/WebFetch result |

A trivial-edit fast path lets a few tiny (< 5-line, non-`replace_all`) `Edit`s
through per window without the full APEX gates (`Write` is never trivial).

## Beyond gating: memory, receipts, one-shot metric

Features shipped since 0.1.44, each with its own test:

- **`CONFIRM <code>` — recourse for a degraded `ask`** — Codex and Kimi both
  ignore `permissionDecision: "ask"` (Kimi's own binary shortcuts on
  `hookSpecificOutput?.permissionDecision !== "deny"`; Codex fails a hook open
  on the unsupported shape), so the harness downgrades every `ask` there to a
  hard `deny`. That deny now appends a short 4-hex-char code; retyping
  `CONFIRM <code>` in the very next prompt authorizes that **exact** action
  once (Claude Code is untouched — its native `ask` still shows an interactive
  confirmation, no code ever appears there,
  `src/runtime/confirm/confirm-gate.ts`). Guardrails, each independently
  testable (`test/confirm.test.ts`, `test/confirm-g0.test.ts`): **G0** no token
  can be placed while a sub-agent is active for this session (a monotone
  max-write timestamp, window tunable via `FUSE_CONFIRM_SUBAGENT_WINDOW_SEC`,
  default 300s); **G1** a token is consumed on first use; **G2** a token
  expires after 5 minutes; **G3** the token is scoped to the action's full
  SHA-256 hash, never the 4-char display code (which collides by design — it
  exists only for a human to retype); **G4** irreversible commands
  (`push --force`, `reset --hard`, `rm -rf`, `git clean -fd`, `branch -D`, …)
  are never confirmable, regardless of a valid token — except a single plain
  `rm` (`-r`/`-rf` included) of literal, non-root targets, which gets a code and
  a `mv <path> ~/.Trash/` hint (the trash move itself needs no code), while an
  `rm -rf` of a root/home/system dir, glob, variable or compound form is denied
  with the hint only; **G5** an explicit
  refusal in the next prompt drops any pending token. **This is a guard
  against accidental/hasty denial with no recourse, not a security control
  against an adversarial agent** — an agent with arbitrary shell access can
  write the token straight into the session-state file it authorizes from and
  self-approve, same as it could bypass any other stateful gate this harness
  keeps outside a sandbox.
- **Deny-loop breaker** — an identical retried call that was already denied gets
  a rewritten `[REPEAT] … STOP` message forcing a different approach, instead of
  looping silently (`src/policy/deny-loop.ts`, `test/deny-loop.test.ts`).
- **Burst-window dedup** — every deployed plugin registers its own hook, so one
  real tool call can fan out to ~11 sibling processes; a same-op record within
  2s is folded into the first instead of re-counted (`src/runtime/burst-window.ts`,
  `test/burst-dedup.test.ts`).
- **One-shot gate metric** — every gate outcome (deny or its later fix) lands in
  a 7-day sidecar keyed by a content-free op hash, so a deny→allow transition is
  visible (`src/tracking/one-shot.ts`, `test/one-shot.test.ts`).
- **Verification receipts** — a static-check or test run is captured from
  PostToolUse Bash output, spanning TS/JS (`tsc`, `bun test`/`vitest`/`jest`/
  `npm|pnpm|yarn test`), Python (`mypy`, `pyright`, `pytest`), Go (`go vet`/
  `build`/`test`), Rust (`cargo check`/`clippy`/`test`), PHP (`phpstan`,
  `phpunit`/`pest`/`php artisan test`), Swift (`swift build`/`test`), and Dart/
  Flutter (`dart`/`flutter test`); `TaskCompleted` **refuses** a "done" over
  modified code files without a fresh passing receipt — the refusal names the
  commands of the detected ecosystem (project markers and the extensions of
  the files changed in the session), falling back to the full cross-language
  list only when nothing is detected (`src/runtime/lifecycle/receipt-hint.ts`).
  Commands are matched
  after quote/heredoc stripping (a tool name mentioned in a commit message or
  heredoc body is never a receipt) — and the recognised runner must be the
  LAST command of the line: the unquoted text is split into shell list
  segments on `;`/`&&`/`||`/a lone `&`/newline (never a bare pipe, which still
  carries the runner's real output forward), and only the LAST segment is
  searched, so `bun test && git commit -m x` and `bun test || true` both null
  while `cd x && bun test` and `bun test 2>&1 | tail -5` both still resolve. A
  zero-test invocation (`--watch`, `--collect-only`, `0 passed; 0 failed`) is
  never treated as proof, and static checkers (`tsc`, `go vet`/`build`, `cargo
  check`/`clippy`, `swift build`) parse their OWN diagnostics so a masked exit
  code doesn't hide a real failure. A residual trade-off: a truncating pipe
  (`cargo test --no-fail-fast 2>&1 | tail -5`) can still cut away a failing
  target's own `test result: FAILED` line — `cargo test`'s parser also counts
  cargo's own trailing `error: N targets failed` line as a fail floor, but a
  pipe that removes ALL evidence remains an accepted risk, in exchange for
  correctly resolving genuine `| tail`/`| grep` pipelines instead of nulling
  every piped command. A receipt needs POSITIVE evidence (a
  parsed summary or the tool's success line): output suppression
  (`2>/dev/null`, ANY output redirection after the runner in its own
  segment — not just `/dev/null` — for a static checker, a stdout redirect for
  a test runner, or a pipe after a static checker), `--version`/`--help`/other
  no-run flags, and silent/ambiguous output never count. **Threat model**: a
  receipt guards against forgetting to verify and against honest shortcuts (a
  discarded exit code, an informational invocation, a filtered run) — it is
  NOT a security control against an agent that deliberately fabricates tool
  output, same caveat as the `CONFIRM` code above.
  (`src/tracking/receipt-runners.ts`, `src/tracking/receipt-command.ts`,
  `src/tracking/receipts.ts`, `test/receipt-runners.test.ts`,
  `test/receipts.test.ts`, `test/receipt-runners-forgery.test.ts`,
  `test/receipt-runners-hardening.test.ts`,
  `test/receipt-runners-evidence.test.ts`,
  `test/receipt-runners-structural.test.ts`).
- **Decision-time lessons** — a `MEMORY/LESSON.md` bullet tagged with
  `[TRIGGERS tool:… path:… error:… keyword:…]` is injected as `additionalContext`
  the moment a matching call is about to repeat a known mistake, cooldown-guarded
  (`src/policy/lessons/lesson-gate.ts`).
- **Failure lessons** *(Claude-Code-only — no `PostToolUseFailure` hook on Codex/Hermes,
  `src/runtime/lifecycle/failure-lesson.ts:8-9`)* — a tool failure's error message is
  matched against `error:`-triggered lessons and injected on the spot
  (`test/failure-lesson.test.ts`, `test/sim/scenarios/17-failure-lesson.json`).
- **TeammateIdle anti-false-done** *(Claude-Code-only, `teammate-idle-check.ts:9-10`)* —
  files a teammate announced as changed are checked against disk; a missing file
  warns the lead before it's treated as done (`test/teammate-idle-check.test.ts`).
- **PostCompact re-injection** — after context compaction, the reconciliation
  snapshot is re-sent with a "reread files before editing" reminder, deduped per
  session (`src/runtime/lifecycle/post-compact.ts`, `test/post-compact.test.ts`).
- **Reconciliation snapshot at SessionStart** — git state, running harness
  version + drift vs. npm, `.claude/BOARD.md`, and the one-shot summary, each
  collector isolated so one failure can't blank the rest
  (`src/runtime/lifecycle/snapshot/index.ts`, `test/snapshot.test.ts`).
- **Target-aware root-doc injection** — `SessionStart` and `UserPromptSubmit`
  inject the target's own root instructions doc, not a hardcoded `CLAUDE.md`:
  `apexDocName(id)` + `harnessHomeSegment(id)` (`src/policy/apex-target.ts`)
  resolve `AGENTS.md` under `.codex`/`.kimi-code` for Codex/Kimi, `CLAUDE.md`
  under `.claude` for every other target (byte-identical to the pre-target-aware
  default). The `systemMessage` label follows suit (`"AGENTS.md injected"`
  under Codex/Kimi) (`src/runtime/lifecycle/session-start.ts`,
  `src/runtime/inject-context.ts`).
- **Injection budget cap** — harness-produced context fragments (lessons,
  snapshot, APEX task context) are capped at ~8000 chars each; owner-authored
  content (CLAUDE.md/rules) is never capped
  (`src/runtime/inject-budget.ts`, `test/inject-budget.test.ts`).
- **Hook simulator** — 18 end-to-end scenarios (payload in, expected verdict out)
  replayed against the real CLI in both `src` and built `dist` modes in CI
  (`test/sim/README.md`, `test/sim/scenarios/`).
- **Codex `multi_agent_v2` custom-agent evidence** — a `spawn_agent` call
  carrying `tool_input.agent_type` is recorded as `subagent-<agent_type>` in the
  same SessionTrack as Claude Task evidence, so a Codex explore-codebase/sniper
  satisfies the APEX freshness gates exactly like a Claude subagent
  (`src/tracking/session-state.ts`, sim scenario 32b). Recognized
  agent-launcher tools across targets: `Task` (Claude), `Agent`/`AgentSwarm`
  (Kimi Code) — each credits its `subagent_type`/`agent_type` toward the same
  freshness evidence (`src/runtime/activity.ts`,
  `src/freshness/agent-evidence-record.ts`).
- **File-size gate judges the real Edit outcome, not the on-disk count** — an
  Edit on a file already over `FUSE_SOLID_MAX_LINES` used to be denied
  unconditionally (the on-disk count always won); the gate now computes the
  actual post-edit line count and allows a shrinking Edit while still denying a
  computable growth past the limit (`src/policy/file-size.ts`, sim scenario 33).
- **Codex `apply_patch` fan-out to post-handlers** — each file in a patch
  envelope becomes a synthetic per-file PostToolUse event (`add`→`Write`,
  `update`→`Edit`, `delete` no-ops on the Write/Edit-only handlers) instead of
  the whole-patch shape whose own `filePath`/`content` are always undefined
  (`src/runtime/post-fanout.ts`, `test/apply-patch-post.test.ts`).
- **Non-blocking multi-file security advisory** — the same PreToolUse "read the
  security skill" nudge a single Write/Edit gets is now evaluated per file
  across a Codex `apply_patch` envelope, firing on the first qualifying
  add/update code file (delete ignored outright) — `additionalContext` only,
  never a deny (`src/runtime/lifecycle/security/check-skill.ts::securityAdvisoryForPatch`,
  `test/security-advisory-patch.test.ts`).
- **Codex SessionStart agent/command resync** — the plugin agents/commands
  cache under `~/.codex/{agents,prompts}` is re-materialized only when its
  sha256 fingerprint changed (or a command symlink dangles) since the last
  apply, otherwise a cheap no-op; agents are copied (Codex won't load
  symlinked TOMLs), commands are symlinked; a best-effort inter-process lock
  avoids a torn cache under concurrent session starts (`src/runtime/lifecycle/codex-resync/`,
  `test/resync-agents.test.ts`).
- **Codex failure tracking inferred from PostToolUse** — Codex reports every
  outcome, success or failure, on the same `PostToolUse` event; a failure is
  classified from an explicit signal only (non-zero exit, an error field —
  never "can't tell") and journaled into the existing one-shot failure tally
  (`src/tracking/codex-post-failure.ts`, `test/codex-post-failure.test.ts`).
- **Shell-credited ref reads** — a `.md` SOLID/skill reference read through a
  read-only shell command (`cat`/`head`/`tail`/`sed`/`rg`/`less`/`more`/`bat`,
  including inside a `sh -c` wrapper) now credits the same ref-read evidence a
  native `Read` would, so a Codex teammate's shell-first consultation still
  satisfies `solidReadGate`; `sed -i`/`--in-place` and any non-whitelisted
  command are never credited (`src/policy/shell-read-refs.ts`,
  `test/shell-read-refs.test.ts`).

### Notification sounds

A native OS sound plays on two lifecycle events: the core-scope `Stop` under
Codex (`stopCore`, since Claude Code already voices its own turn-end via a
native `afplay` hook — this harness deliberately does not double it) and
`TeammateIdle` under Claude Code when there's an actionable notice (a missing
deliverable or a sniper reminder). **On by default**; opt out entirely with
`FUSE_HARNESS_SOUND=0`.

Resolution per event kind (`stop`/`permission`/`human`) cascades: (1) a
per-kind env override path (`FUSE_HARNESS_SOUND_STOP` / `_PERMISSION` /
`_HUMAN`) if it exists on disk; (2) the package's own bundled
`assets/song/{finish,permission-need,need-human}.mp3` (located by walking up
to the running `package.json`, so it survives the flat/hashed `dist/` build);
(3) `$CLAUDE_PLUGIN_ROOT/song/<file>.mp3` as a last-resort fallback. No file
resolves → silent no-op. The `permission` kind and its `.mp3`/env var exist in
the module for symmetry but have no current call site — permission prompts
stay native-only on every harness today.

Playback is native per platform (`afplay` on darwin, `paplay` on linux,
PowerShell's `SoundPlayer` on win32) and **absolutely fail-open**: an
unsupported platform, a missing player binary, an undecodable file, or a
non-zero exit is swallowed — a broken or absent player can never break a hook
(`src/runtime/notifications.ts`, `src/runtime/notification-sound.ts`,
`test/notifications.test.ts`).

### Environment

| Var | Effect |
|---|---|
| `FUSE_SOLID_MAX_LINES` | SOLID file-size limit (default `100`). |
| `FUSE_HARNESS_REFS` | Explicit `path.delimiter`-list of `.md` SOLID-reference dirs → activates `solidReadGate`. Overrides auto-discovery. |
| `FUSE_HARNESS_MARKETPLACES` | Comma-list of marketplace names whose `solid-*` skill refs are auto-discovered when `FUSE_HARNESS_REFS` is unset (default `fusengine-plugins`). |
| `FUSE_ENFORCE_TTL_SEC` | APEX freshness window in seconds (default `120`). |
| `FUSE_LESSONS_THROTTLE_MIN` | Lessons-injection throttle, minutes (default `5`). |
| `FUSE_ENFORCE_GEMINI_MCP` | **Opt-in (default off).** Blocks hand-written Tailwind UI (`.tsx/.jsx/.vue/.svelte`) until a `mcp__gemini-design__*` call is made this session. Read fresh per call (`src/policy/gemini-mcp-gate.ts`). |
| `FUSE_DESIGN_GEMINI` | **Opt-in (default off), a *different* gate from the one above.** Enables the design-pipeline's own Gemini gates (`create_frontend` validation + "generate before hand-writing HTML/CSS") — inert unless a design agent is active (`src/policy/design/gates.ts:58-60`, see [docs/design.md](docs/design.md)). |
| `FUSE_PRD` | **Opt-in (default off).** Set to exactly `1` to activate task/agent PRD ownership coordination — still inert without a `prd.json` router under `<homeSeg>/apex/`. See [PRD coordination](#prd-coordination-opt-in) below and [docs/prd.md](docs/prd.md). |
| `FUSE_MCP_TTL_SEC` | MCP (Context7/Exa) cache freshness, seconds (default 48h, `src/runtime/mcp-key.ts`). |
| `FUSE_WEBFETCH_TTL_SEC` | WebFetch cache freshness, seconds (default 24h — pages stale faster than docs). |
| `FUSE_CONFIRM_SUBAGENT_WINDOW_SEC` | G0 cool-down (seconds, default `300`) for the `CONFIRM <code>` mechanism above — no token can be placed within this window of the last SubagentStart/Stop seen for the session. |
| `RALPH_MODE` | **Opt-in (default off).** Exempts safe git commands (`add`/`commit`/`checkout -b`/`status`/`diff`/`log`) from the confirmation ask and auto-approves project installs. Destructive git (force-push, `reset --hard`) and system installs still gate. |
| `CLAUDE_PROJECT_DIR` | Overrides the project root used to hash the out-of-tree state dir (`src/runtime/paths.ts:20`). |
| `FUSE_HARNESS_SOUND` | **On by default.** Set to `0` to disable every lifecycle notification sound. |
| `FUSE_HARNESS_SOUND_STOP` / `_PERMISSION` / `_HUMAN` | Per-kind override: an absolute path to a sound file to play instead of the bundled `assets/song/*.mp3` for that kind (see [Notification sounds](#notification-sounds)). |

## Library usage

```ts
import { detectHarness } from "@fusengine/harness/detect";
import { evaluate } from "@fusengine/harness/policy";
import { gate } from "@fusengine/harness/runtime";

const { id, mode } = detectHarness();            // { id: "cursor", mode: "hook" }

// stateless guards (file-size, git, security, …)
const verdict = evaluate({ tool: "Write", filePath: "src/big.ts", content });
if (verdict.decision !== "allow") console.error(verdict.prompt?.reason);

// full gate (stateless + stateful APEX, fed from the session track)
const prompt = await gate({ sessionId, framework: "react", tool: "Write",
  filePath: "src/Button.tsx", content, now: Date.now(), trackFile });
```

The `Prompt` it returns (`{ kind: "block" | "ask" | "inform", title, reason, actions? }`)
is portable; each adapter maps it to the harness's native shape — but, per the
compatibility matrix above, not every harness can act on every `kind`.

### Extend it

Add your own project rules without forking — they run **after** the privileged
core chain (two-tier), and the chain is **fail-closed** (a guard that throws blocks,
never silently passes):

```ts
import { registerGuard } from "@fusengine/harness/policy";

registerGuard(({ tool, command }) =>
  tool === "Bash" && command?.includes("kubectl delete")
    ? { kind: "ask", title: "Confirm cluster change", reason: command }
    : null);
```

## PRD coordination (opt-in)

Set `FUSE_PRD=1` and write a router file so a lead can split one task
across several sub-agents, each restricted to writing only its own
report. Full walkthrough, guard behavior, and the CLI: [docs/prd.md](docs/prd.md).

Minimal example — `.claude/apex/prd.json`:

```json
{ "auth-refactor": { "prd": "prd/auth-refactor-prd.json", "status": "assigned" } }
```

## Subpath exports

| Subpath | What |
|---------|------|
| `./detect` | `detectHarness()` / `detectMode()` — 13 harnesses, `hook` vs `cli`. |
| `./policy` | `evaluate(ctx)`, the guard chain, `evaluateApex`, framework detection. |
| `./runtime` | `handleHook`, `gate`, `recordActivity`, `activityFor`, per-harness storage + MCP intercept. |
| `./tracking` | Session track: `recordAgent/Doc/RefRead`, `agentsFresh`, receipts, one-shot metric. |
| `./refs` | Frontmatter parse, `loadRefs(dir)`, SOLID ref scoring/routing. |
| `./prompt` | The portable `Prompt` type + `formatPrompt`. |
| `./cache` | MCP/WebFetch cache: key, lookup/store, compaction, response extraction. |
| `./memory` | Per-project "never reproduce" lessons. |
| `./config` `./util` `./state` `./statusline` `./freshness` `./init` `./cli` | env config, project-root, locks, statusline, doc-freshness, wiring templates, staged checks. |
| `./adapters/{claude,codex,cursor,cline,gemini,hermes}` | Thin per-harness adapters — see [Compatibility](#compatibility) for what each can actually enforce. |

## Documentation

| Guide | What |
|-------|------|
| [docs/index.md](https://github.com/fusengine/harness/blob/main/docs/index.md) | architecture overview + map |
| [docs/detect.md](https://github.com/fusengine/harness/blob/main/docs/detect.md) | harness detection (`hook` vs `cli`) |
| [docs/policy.md](https://github.com/fusengine/harness/blob/main/docs/policy.md) | `evaluate`, the guard chain, framework, APEX gates |
| [docs/guards.md](https://github.com/fusengine/harness/blob/main/docs/guards.md) | the guard chain, `registerGuard`, fail-closed |
| [docs/runtime.md](https://github.com/fusengine/harness/blob/main/docs/runtime.md) | `handleHook`, `gate`, tracking, MCP intercept, state paths |
| [docs/config.md](https://github.com/fusengine/harness/blob/main/docs/config.md) | env config (TTL, max-lines, refs dir, Gemini opt-ins) |
| [docs/modules.md](https://github.com/fusengine/harness/blob/main/docs/modules.md) | cache · refs · state · memory · statusline · util |
| [docs/adapters.md](https://github.com/fusengine/harness/blob/main/docs/adapters.md) | adapters, compatibility, `harness init`/`hook` wiring |
| [docs/design.md](https://github.com/fusengine/harness/blob/main/docs/design.md) | design-agent pipeline — state machine, gates, opt-in Gemini |
| [docs/prd.md](https://github.com/fusengine/harness/blob/main/docs/prd.md) | PRD task/agent ownership coordination — opt-in, `FUSE_PRD=1` |
| [CHANGELOG.md](https://github.com/fusengine/harness/blob/main/CHANGELOG.md) | release history |

Run `bun run docs:api` for the generated typedoc API reference.

## Known limitations

- **Codex `apply_patch` enforcement depends on Codex itself.** The harness
  parses the patch and emits the right verdict per file, but Codex does not
  always enforce a correct deny on its end (openai/codex#27833, see
  [Compatibility](#compatibility)) — enforcement beyond the verdict is theirs.
- **Cursor file edits are advisory-only.** `afterFileEdit` fires after the edit
  already happened — a platform limit, not something this harness can work around.
- **Hook fan-out is mitigated, not eliminated.** The ~11-sibling-plugin burst is
  deduped within a 2s window (`BURST_DEDUP_MS`), but that window is a heuristic,
  not a protocol guarantee — an unusually slow fan-out could in theory land
  outside it.
- **Sidechain hook reliability is a platform issue, worked around, not fixed.**
  Sub-agent `PostToolUse` hooks don't always fire on Claude Code (documented
  platform issues #43612/#27655/#34692); `SubagentStop` transcript harvesting
  (`src/freshness/evidence-harvest-io.ts`) compensates, but only at that
  checkpoint, not continuously.
- **Hermes coverage beyond `pre_tool_call` is unverified** — no lifecycle events
  have been proven against a live Hermes install in this repo.
- **`CONFIRM <code>` is not a security boundary.** It guards against an `ask`
  being silently dropped by Codex/Kimi's degrade-to-deny, i.e. against
  precipitation and lost recourse — not against an adversarial agent. Any
  agent with shell access can write its own confirm token into session state
  and self-approve; this is true of every stateful gate this harness keeps
  outside a sandbox, not specific to this mechanism.
- **The CONFIRM relay guard has known gaps.** It denies a code relayed through
  a nested agent CLI or session typer, but not text decoded or assembled at run
  time, a prompt read from a file written earlier, an `ssh` to a host running
  `kimi`, or a variable used as the command name
  ([docs/adapters.md](docs/adapters.md#confirm-relay-guard-core-path-every-host)).
- **Codex plain `rm` relies on the hook.** `harness codex-rules` emits no
  prompt rule for `rm` (it would become Forbidden under `approval_policy=never`
  and make the CONFIRM code unusable), so if the hook does not run on Codex
  (crash, timeout, untrusted hook) plain `rm` is not gated by exec-policy.
  Regenerate and reinstall `~/.codex/rules/fusengine.rules` after upgrading.

## Develop

```sh
bun test            # 662 tests (120 files)
bunx tsc --noEmit   # typecheck (isolatedDeclarations)
bun run build       # dist + .d.mts via tsdown (for Node/bundler consumers)
bun run docs:api    # generate the typedoc API reference
```

CI runs test + typecheck on every PR. MIT licensed.

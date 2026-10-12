# Changelog

All notable changes to `@fusengine/harness`. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

## [Unreleased]

## [0.1.108] - 2026-10-12

### Changed

- **inject: per-recipient session registry — Claude Code hook injections delivered in full** (`src/runtime/inject-session/`, `src/runtime/handle.ts`, `src/runtime/lifecycle/dispatch.ts`, `src/runtime/pre-allow.ts`, `src/cli/rdv/follower.ts`) — blocks are chunked under 9 500 chars (no 2 KB preview truncation), the loader copy owns each block, true duplicates are trimmed and the per-prompt recall is kept; the registry is removed on SessionEnd; pre-tool lessons fire once per session/sub-agent. Codex, Cursor, Kimi and Gemini output is byte-identical. Tests: `inject-session-*`.

### Added

- **lessons: the harness asks for lessons in caveman style** (`src/runtime/lifecycle/lessons/reminder.ts`, `src/runtime/lifecycle/lessons/dispatch.ts`) — the Stop reminder and the per-prompt lessons suffix ask for telegraphic bullets that never drop not/never/no/only and keep commands, paths and numbers verbatim. `MEMORY/LESSON.md` compacted to caveman style, triggers unchanged. Golden fixture `inform-matrix` updated for the new suffix.

## [0.1.107] - 2026-10-12

### Added

- **apex: the deny lists every missing prerequisite at once** (`src/policy/apex-missing.ts`, `src/runtime/gate-apex.ts`) — instead of stopping at the first failing gate, the deny now lists all missing prerequisites; the PRE-block lists only ref-free gates and never loads refs. Same block/allow verdict, same title; a single failure is byte-identical to before. Tests: `apex-deny-all-missing`.
- **solid: detect react, tanstack-start, astro, java, csharp, ruby and generic projects; the limit follows `FUSE_SOLID_MAX_LINES`** (`src/runtime/lifecycle/solid-detect.ts`, `solid-detect-extra.ts`) — only projects previously typed "unknown" get a type. `SOLID_FILE_LIMIT` = `FUSE_SOLID_MAX_LINES` when set, else the profile default; output with the variable unset is unchanged. Tests: `solid-detect-stacks`.

### Fixed

- **guards: the perl timeout idiom and pure reads no longer hit "perl in-place edit"** (`src/policy/guards/bash-write.ts`, `bash-write-patterns.ts`, `bash-write-inline.ts`, `bash-write-perl.ts`, `bash-write-perl-words.ts`) — verdict identical to 0.1.106 except two exemptions: pure-read programs whose `-p`/`-i` tokens are file names or program text, and `perl -e 'alarm N; exec @ARGV'` with a bare claude/codex/kimi/cursor/cursor-agent child (the existing exec CONFIRM still applies). 1387-command differential with real perl under 8 shells: 0 in-place edit loosened, 0 stricter. Tests: `bash-write-perl-inplace`, `bash-write-perl-narrow`.

### Known limits

- The perl rule keeps 0.1.106's existing gaps (e.g. `/usr/bin/perl -pi`, `bash -c "perl -pi …"`), deliberately unchanged.
- `test/multi-rdv-sim` scenario 01 can fail when `TMPDIR` is set (pre-existing, same on 0.1.106).

## [0.1.106] - 2026-10-11

### Fixed

- **motion: field references in a multi-line awk program (`$3`, `$NF`, `${2}`) are no longer read as currency amounts** (`src/policy/motion/program-bodies.ts`, `sensitive.ts`) — only inside a single-quoted awk/gawk/mawk body in shell command position (not in a quote, `#` comment or heredoc), closed, containing `{`, and only in code position; awk string literals, awk comments and bullet lines keep their amounts; `sh -c`/`bash -c` and double-quoted awk bodies are scanned as before. Known limit: a prose line with an amount placed inside an otherwise-awk body (not valid awk) is not flagged. Tests: `motion-sensitive`, `motion-sensitive-diff`.
- **design: `design-system.md` is resolved from the written file's directory upward** (`src/runtime/design.ts`, `design-helpers.ts`, `design-files-gate.ts`) — real paths, confined to the real cwd, empty/unreadable candidates skipped, then cwd; per-file verdict for Write/Edit/apply_patch; session mode/quota unchanged (still decided from cwd). Tests: `design-system-locate`, `design-init-parity`.
- **design: deny texts list exactly what is missing** (`src/policy/design/gates-pipeline.ts`) — corpus reads counted at the credited root (with its path) and screenshots taken/required (N/M); any fuse-browser capture counts. Blocking conditions and thresholds unchanged. Tests: `design-refusal-text`, `design-html-css-pipeline-gate`.
- **motion: the PreToolUse budget note counts completed renders (incremented by PostToolUse)** — verified, not a bug; test added: `motion-budget-note`.

## [0.1.105] - 2026-10-11

### Fixed

- **motion: a PreToolUse delivered twice with the same tool_use_id is idempotent instead of blocking itself** (`src/runtime/motion/pre.ts`) — Claude Code may deliver the SAME PreToolUse Bash twice (same session, same `tool_use_id`, same command): the first pass reserved the render and answered with the "Motion render" note, and the second pass was denied by its own reservation ("Motion concurrent render"), each retry opening a new reservation. On a host with a native id (not `noid:`), a second pass whose id already owns a FRESH in-flight reservation AND whose receipt matches session, stage and command now replays the first verdict — the same "Motion render" budget note — with no new reservation and budget and state byte-identical. Unchanged: another `tool_use_id` of the same stage is still denied while a reservation is fresh; the same id with a different command, session or stage keeps the existing refusals; `noid:` ids (derived from session + command, a real second call is indistinguishable) and ids present only in `expired` stay refused; approvals G1/G2, the master cap, quarantine and the TTL are untouched, and a corrupt budget stays fail-closed. Test: `motion-dup-pre`.

## [0.1.104] - 2026-10-11

### Fixed

- **motion: stale in-flight render reservations expire (TTL); only SubagentStop with an `agent_id` releases one (claude-code only)** (`src/policy/motion/budget.ts`, `budget-store.ts`, `src/policy/interfaces/motion.ts`, `src/runtime/motion/pre.ts`, `post.ts`, `lifecycle.ts`, `index.ts`) — a render reserved at PreToolUse whose tool never ran no longer blocks its stage forever: entries older than `FUSE_MOTION_RENDER_TTL_MS` (default 30 min, same parsing as the master-cap env) stop blocking concurrent admission and stop counting against `FUSE_MOTION_MAX_MASTER_RENDERS`, but move to a retained `expired` map instead of being forgotten — a late completion (PostToolUse/PostToolUseFailure) settles exactly like an unexpired render (same `renders`/`wallMs` budget effect, same output attribution, no spurious quarantine), so the master cap sees late finishers. Expired entries are forgotten only past a fixed 24 h horizon (`RENDER_FORGET_MS`), which bounds reservations whose tool never ran. The main turn's Stop releases NO reservation on any host: a sub-agent's PreToolUse may carry no `agent_id`, so its reservations are indistinguishable from the main turn's — a main-turn leak falls by the TTL alone. On claude-code only, a SubagentStop with a non-empty `agent_id` releases that sub-agent's FRESH reservations (only entries written with the exact same `agent_id` can match, so this is safe on every host version — a render still running in another agent keeps blocking; entries written before 0.1.104 carry no session id and expire by TTL only); codex gets no release — an `exec_command` returns control to the model while the process keeps running, so a sub-agent can emit SubagentStop while its render is still active — and every other host relies on the TTL and the 24 h horizon alone; expired reservations, native-id or `noid:`, are never released by a stop event and stay settleable. The release is best-effort: a corrupt or busy budget is left untouched and never turns SubagentStop into a denial. Fresh same-stage reservations still block concurrent renders, approvals G1/G2, HMAC signing and quarantine are unchanged for any render within the TTL, and a corrupt budget stays fail-closed and byte-identical. Tests: `motion-inflight-ttl`, `motion-inflight-agent`, `motion-inflight-late`, `motion-owner-leak`, `motion-stop-subagent`; `motion-hardening4-store` updated (a fresh reservation still blocks at age = TTL).
- **motion: an expired `noid:` reservation refuses the identical command until settlement or the 24 h horizon** (`src/runtime/motion/pre.ts`, `src/policy/motion/budget.ts`, `src/runtime/motion/lifecycle.ts`) — on hosts without a native tool-call id (gemini-cli, cline, hermes, cursor without id) the render id derives from session + command, so relaunching the same command in the same session reproduced an id still retained in `expired`: the re-run was admitted while the first render could still be running (the id then lived in `inflight` AND `expired`, the first completion settled the fresh entry with a wrong wall time, the second completion was never counted — 2 renders, 1 counted — and on draft/master the first post removed the shared receipt, quarantining the second render's outputs). The same command is now refused with the existing "Motion render identity" denial until the late completion settles the reservation or the 24 h horizon forgets it — an id never exists in both maps. No host ever releases an expired `noid:` reservation, so a leaked `noid:` reservation keeps refusing the identical command until settlement or the horizon; expired reservations with a native (unique-per-call) id stay retained for late settlement, unchanged. Best-effort and fail-closed like the fresh-release path. Test: `motion-noid-expired`.
- **motion: a sub-agent's stop event never releases the main turn's reservations; an expired id refuses re-admission** (`src/runtime/motion/host.ts`, `index.ts`, `src/policy/motion/budget.ts`) — gemini-cli fires `AfterAgent` (mapped to `stop`) at a sub-agent's end too, with `agent_name` and no `agent_id` (gemini-cli PR #25033, and only on versions carrying it), and the release freed the main turn's FRESH in-flight reservations while their render could still be running (render < TTL never counted, same stage re-admitted concurrently — HEAD refused both). No stop event releases anything on these hosts; on claude-code only a SubagentStop carrying the stopped sub-agent's `agent_id` releases that agent's fresh reservations — the main turn's Stop releases nothing anywhere, codex and every other host release nothing on a stop event (the TTL stays the backstop), and the stdout of these events is unchanged. `openRender` also refuses an id already present in the retained `expired` map with the existing duplicate-id denial, so an id can never live in `inflight` and `expired` at once. Test: `motion-stop-subagent`.
- **motion: the main turn's Stop never releases a reservation; SubagentStop release is restricted to claude-code** (`src/runtime/motion/host.ts`, `index.ts`, `lifecycle.ts`) — on kimi a foreground sub-agent ends with a marker-free `Stop` carrying the shared session id (payload: `hook_event_name`, `session_id`, `cwd`, `stop_hook_active` — kimi-cli hooks/events.py, subagents/runner.py, soul/agent.py), indistinguishable from the main turn's end, with tool calls of one step running in parallel; and a sub-agent's PreToolUse may carry no `agent_id`, so its reservations are indistinguishable from the main turn's: releasing on Stop freed fresh reservations while a render could still be running (render never counted, concurrent render admitted, outputs quarantined). The main turn's Stop now releases NOTHING on any host — a main-turn leak falls by the TTL (30 min default) — and kimi, codex, cursor, gemini-cli, cline and hermes get NO release on Stop/SubagentStop at all, relying on the TTL and the 24 h horizon alone (on codex an `exec_command` returns control to the model while the process keeps running — no PostToolUse until it finishes and the process can outlive the turn — so a sub-agent can emit SubagentStop while its render is still active; releasing there would admit a concurrent render and lose the late completion). On claude-code only, a SubagentStop with a non-empty `agent_id` releases the FRESH reservations carrying exactly that `agent_id` (only entries whose PreToolUse bore that id can match — safe on every version); expired reservations stay settleable. The stdout of all these events is unchanged, the release stays best-effort, and a corrupt budget stays fail-closed and byte-identical. Tests: `motion-stop-subagent` (kimi/cursor/gemini-cli no-release, codex Stop no-release, codex SubagentStop no-release with late completion counted), `motion-owner-leak` (main Stop releases nothing; TTL backstop), `motion-noid-expired` (no expired `noid:` release).

## [0.1.103] - 2026-10-08

### Added

- **Motion G1 stills approval gate** (`src/policy/motion/gates.ts`, `src/runtime/motion/`, `src/runtime/handle.ts`) — the new `motion` hook scope (`hook <host> motion`) for fuse-motion denies draft renders without owner approval bound to the SHA-256 of `.motion/stills/contact.png`.
- **Measured multi-host motion support** (`src/runtime/motion/host.ts`, `src/runtime/motion/reply.ts`, `src/runtime/motion/files.ts`, `src/runtime/motion/index.ts`, `src/runtime/motion/pre.ts`, `src/runtime/motion/post.ts`, `src/runtime/motion/prompt.ts`) — native payloads against `dist/cli/bin.mjs` on 2026-10-08 passed draft refusal, store-write refusal, prompt approval recording and approved render in a new session for claude-code, codex, cursor, kimi, gemini-cli, cline and hermes, with native deny responses. Cursor blocks writes in `preToolUse`, not post-write `afterFileEdit` (response `{}`); opencode remains untested. These measurements do not establish live host application, G2, critic lifecycle or budget parity.
- **Motion G2 draft approval gate** (`src/policy/motion/gates.ts`, `command.ts`) — master renders and ffmpeg writes to declared master outputs require approval of the draft's exact SHA-256; an artifact changed since approval is denied as stale and needs re-approval.
- **Owner-only motion approvals** (`src/policy/motion/approve-prompt.ts`, `approvals.ts`, `src/runtime/motion/prompt.ts`) — an exact `MOTION-APPROVE <stage> <code>` entered through the host's native prompt event grants only a matching pending request and current artifact hash; sub-agent payloads and automated envelopes cannot approve. An explicit refusal cancels the session's pending requests.
- **Motion self-approval guard** (`src/policy/motion/self-approval.ts`, `src/policy/guards/protected-path.ts`) — agent writes to `~/.fuse-harness/motion/` and `~/.fuse-harness/motion-keys/` are denied through write tools and Bash; both paths are also protected by the shared path guard **for every hook scope** (the only behavior change outside `motion`; reads stay allowed).
- **Signed approvals** (`src/policy/motion/auth-key.ts`, `auth-approval.ts`, `state-witness.ts`) — approvals are HMAC-SHA256 signed with a per-project `0600` key in `~/.fuse-harness/motion-keys/`; unsigned records are ignored, and keys or approvals the harness's own registry never recorded (planted before first observation) are not trusted.
- **Motion state verification** (`src/policy/motion/state.ts`, `state-files.ts`, `src/runtime/motion/post.ts`, `index.ts`) — after every tool call and at Stop, a draft/master not produced by an authorized render in that same call is moved to `.motion/quarantine/` (never deleted); key, store or `project.json` changed outside the harness invalidates every approval of the project. Artifacts found at first observation stay in place but never count as approved; an authorized render's partial output is left alone while it runs.
- **Motion detach guard** (`src/policy/motion/guard-detach.ts`) — in a motion project, Bash commands that detach a process (`nohup`, `setsid`, `disown`, trailing `&`, `at`, `launchctl`) are denied so writes cannot be deferred past the state check.
- **Motion approval forgery guard** (`src/policy/motion/forgery.ts`) — Bash commands and CronCreate, ScheduleWakeup, RemoteTrigger or SendMessage inputs carrying `MOTION-APPROVE` are denied, preventing agents from relaying the approval phrase through scheduled or cross-session prompts.
- **Sensitive motion-source write scan** (`src/policy/motion/sensitive.ts`, `src/runtime/motion/pre.ts`) — checks the full Write/Edit/MultiEdit content under the motion source directory for terms from `~/.fuse-harness/motion/banned.txt` or currency amounts (shell positional parameters such as `$1` are not amounts); detected values are denied and reported masked.
- **Motion critic sandbox** (`src/policy/motion/critic.ts`, `critic-flag.ts`, `src/runtime/motion/lifecycle.ts`) — read-only checks for `motion-critic` deny write tools, limit Read to media or the review pack, and limit Bash to ffprobe/ffmpeg/ls/stat; ffmpeg output arguments must stay in the review directory, and shell redirections must stay there or target `/dev/null`. SubagentStart activates the checks and SubagentStop clears them by agent id.
- **Motion render budget** (`src/policy/motion/budget.ts`, `src/runtime/motion/pre.ts`, `post.ts`, `host.ts`) — reserves a render at PreToolUse, counts it once at PostToolUse and releases it on tool failure, with wall time per stage; correlation uses each host's native call id (Kimi `tool_call_id` included), session-scoped and collision-free. `FUSE_MOTION_MAX_MASTER_RENDERS` denies further master renders when its configured cap is reached (unset or invalid means no cap). A corrupt budget is never repaired automatically. Known limit: a render cancelled with no terminal event keeps its reservation (no time-based expiry).
- **Motion approval-store failure handling** (`src/policy/motion/store.ts`, `gates.ts`, `src/runtime/motion/index.ts`) — missing or corrupt approval state denies gated renders, and failure to save a pending request never turns that deny into an allow; other internal exceptions fail open with a diagnostic on stderr.

### Changed

- **Internal hook payload helpers extracted** (`src/runtime/handle-payload.ts`, `src/util/record-object.ts`) — `rawEventName` and `cursorRawPayloadProjection`, with their parsing helper, moved out of `handle.ts` without changing their behavior; `segments`, `tokenize` and `REFUSAL_RE` are exported unchanged for reuse by `motion`.

### Fixed

- **CONFIRM multi-pending, visible ack** (`src/runtime/confirm/` — `codex-confirm-state.ts` (new), `confirm-outcome.ts` (new), `confirm-feedback.ts` (new), `codex-confirm.ts`, `confirm-pending.ts`, `confirm-state.ts`, `confirm-submit.ts`, `confirm-gate.ts` — `src/runtime/handle.ts`) — a session now keeps up to 10 pending CONFIRM codes (oldest evicted): a new denial no longer erases a code already given, an armed token survives the denial of an unrelated command, a pending code NEVER expires and survives arming on the shared path (an expired token re-arms by retyping the code), and a refusal drops only the armed tokens there (codex clears its pending too, as before); the legacy single-slot state files are still read. A prompt that is exactly `CONFIRM <code>` is acked on kimi/codex (`accepté pour : … (valable 5 min)` / `inconnu — codes en attente : …`); an incidental code inside a longer prompt arms silently, byte-identical output. Tests: `confirm-multi-pending`, `confirm-multi-state`, `confirm-feedback`, `confirm-codex-legacy`.

## [0.1.102] - 2026-10-05

### Fixed

- **Inline trailing `[TRIGGERS …]` tags recognised** (`src/policy/lessons/trigger-tag.ts` (new), `trigger-index.ts`, `src/runtime/lifecycle/aipilot/lesson-parse.ts`, `lesson-inject.ts`, `curate-lessons.ts`). A tag placed inline at the end of a lesson bullet (the form every lesson actually uses) was never recognised, so 0 decision-time lessons were armed and the cap-archive did not protect tagged bullets (the oldest lesson kept getting archived). Inline trailing tags now count for arming, archive protection and dedup carry-over, and are stripped from the SessionStart injection. Inline keyword values may contain spaces; the widening applies only to the inline path. Own-line tags are byte-identical to before (HEAD-vs-tree differential: 20,862 cases, 0 diffs). Test: `lesson-inline-triggers`.
- **Test isolation**: `cursor-authentic-fixtures` and `perf-lazy-refs` now put a `.git` in their temp cwd, so they no longer fall back to the real repo's `MEMORY/LESSON.md`.

## [0.1.101] - 2026-10-05

### Added

- **APEX gates police Codex `apply_patch` per file** (`src/runtime/apply-patch-apex.ts`, `gate.ts`, `gate-apex.ts`, `gate-input.ts`, `inject-dedup-exclusive.ts` `exclusiveHeld`) — each file of an `apply_patch` envelope goes through the APEX freshness gates; the trivial-edit budget is charged once per sibling fan-out. Sim scenarios 22 and 34 now expect explore+research before `apply_patch`. Tests: `codex-apply-patch-apex`, `codex-apply-patch-fanout`.

### Fixed

- **Hook process lifetime bounded** (`src/cli/hook-entry.ts`, `hook-legacy.ts`, `hook-run.ts`, `rdv/`, `stdin-*.ts`, `cursor-stdin-reader.ts`, `hook-io.ts`, `bin.ts`) — the stdin reader was reworked so hook processes can no longer run away and pile up (they had crashed the host). The same work also touched transcript index/sidecar, lazy refs, track spill, sub-agent transcript scan, the aipilot cache, `config/limits.ts` and `util/runtime-io.ts`.
- **Cursor CONFIRM sibling pass** (`src/runtime/confirm/confirm-state.ts` `ConsumeGrace`, `confirm-gate.ts`) — Cursor fires `preToolUse` and `beforeShellExecution` for the same Shell command; a consumed token now allows exactly one sibling pass in the same `generation_id` within 10 s. Test: `confirm-cursor-sibling`.
- **Cursor sub-agent evidence merged into the parent session** at `subagentStop` via `child_conversation_id` (`src/freshness/child-evidence-merge.ts`, `cursor-child-harvest.ts`, `evidence-harvest-io.ts`, `evidence-harvest.ts`) — docs are credited only for frameworks in the child track; the stamp is never regressed nor freshened by another session. Test: `cursor-child-evidence`.
- **CONFIRM typed in Cursor's parent chat unlocks a sub-agent's denied command** (`src/runtime/confirm/cursor-subagent-link.ts`, `confirm-gate.ts`, `handle-pre.ts`) — `subagentStart` `tool_call_id` is linked to the child's `parent_tool_call_id` (hashed key); the gate consumes the parent token, mirrors the pending deny and shows the command. The G0 sub-agent freeze no longer lands on Cursor's parent (human) chat (`dispatch.ts`), and a prompt from a Cursor sub-agent conversation can never arm a CONFIRM (`handle.ts`). Claude/Codex/Kimi G0 unchanged. Test: `confirm-cursor-subagent`.

## [0.1.100] - 2026-09-28

### Added

- **CONFIRM flow on Cursor** (`src/runtime/confirm/confirm-gate.ts`) — Cursor's adapter downgrades `ask` to `permission:"deny"` (`respond.ts`), but Cursor was not in `DEGRADES_ASK_TO_DENY`, so an ask (e.g. `git commit`) was a dead-end deny with no code. Cursor now gets the same `Pour autoriser, réponds : CONFIRM <code>` suffix as Codex/Kimi; the user's reply is armed by the existing shared submit path (`beforeSubmitPrompt` carries `prompt` and the same `session_id`/`conversation_id` as `preToolUse`, measured in real Cursor hook logs). `agent_message` carries the code to the agent (Cursor docs). G4 irreversible commands still never get a code.

### Fixed

- **Multi-candidate MCP calls never confirmable** (`src/runtime/handle-pre.ts`) — a Cursor `beforeMCPExecution` can carry several command candidates; `confirmGate` only saw candidate 0, so a token for a benign head (`ls`) could unlock an `rm -rf` candidate. Those calls (`commandCandidates.length > 1`) now keep the plain deny. Proof on the built dist with the live binary: `git commit` denied with `CONFIRM 0fdd` → `beforeSubmitPrompt` `CONFIRM 0fdd` → `{"permission":"allow"}` once → denied again. claude-code/codex/kimi paths unchanged. Tests: 1897 to 1901 (+4 in the new test file, each verified failing without its fix, no existing test modified).

## [0.1.99] - 2026-09-28

### Fixed

- **Stop hook no longer loops on SOLID / receipt verdicts, with an actionable message** (`src/runtime/lifecycle/stop-notice.ts`, `task-completed.ts`, `stop-core.ts`, `dispatch.ts`) — Stop fires every turn and re-checked the session's whole modified-file list, and on Claude Code a Stop `additionalContext` re-opens the turn (up to 8 consecutive), so an unchanged pre-existing oversized file looped agents (measured in a real session: 305 injections of "SOLID VIOLATION in task '' ()"). On `Stop` only: the SOLID verdict is emitted once per session per content (content-hash dedup via `oncePerWindow`, 24h horizon), re-armed only when a file's line count or the code-file set changes; the VERIFICATION RECEIPT REQUIRED refusal is repeated at most once per `throttleMs()` window (`FUSE_LESSONS_THROTTLE_MIN`, default 5 min, the same cadence as the lessons Stop reminder) while no fresh passing receipt exists, silent in between, and stops once a receipt passes (no new config key). The message names the oversized files and the action to take, without the empty "task '' ()". Stop dedup keys live in dedicated sidecars (`<stateDir>/stop-notice/`, `<stateDir>/stop-receipt/`): the shared `inject-dedup.json` is pruned with each caller's window, so the per-prompt 3 s context-inject dedup was erasing the 24h Stop keys. Codex's Stop schema (`deny_unknown_fields`) rejected `hookSpecificOutput`: the `codex` adapter now gets `{"decision":"block","reason":…}`; every other harness keeps `additionalContext`. The `TaskCompleted` path is byte-identical. Verified with real binaries, 6 consecutive Stops on a 565-line file after one Edit: 0.1.98 emits 6/6 (claude-code and codex), 0.1.99 emits 1/6; with `FUSE_LESSONS_THROTTLE_MIN=0.05`, 8 Stops 1 s apart emit the receipt refusal at t=1, 4, 7 s only, on `hook claude-code core` and `hook codex core`. Tests: 1892 to 1898 (+6 in the new test file, no existing test modified).

## [0.1.98] - 2026-09-25

### Fixed

- **Release metadata exempt from the doc-research / skill-read gates** (`src/policy/release-metadata-path.ts`, `src/policy/shadcn-skill-gate.ts`, `src/policy/skill-triggers.ts`) — a version bump in `plugins/<x>-expert/.claude-plugin/plugin.json` was denied "No MCP research done for shadcn" by `shadcnSkillGate` (path-routed, framework hard-coded) and by the forced architecture skill in `skillTriggerGate`. A single closed-list predicate, `isReleaseMetadataPath()`, now covers `**/.claude-plugin/plugin.json`, `**/.claude-plugin/marketplace.json` and `**/CHANGELOG.md` (whole-segment match, case-sensitive, `/` or `\`); both gates return early for those paths. The SOLID/file-size gate and every other gate are unchanged; a witness such as `.claude-plugin/hooks.json` stays gated. No adapter, message, output, exit code, config key or public API change. End-to-end coverage through `handleHook` for claude-code, codex, cursor and kimi. Tests: 1858 to 1883.
- **Codex-valid SubagentStop / PreCompact / PostCompact outputs** (`src/runtime/lifecycle/agent-memory.ts`, `pre-compact.ts`, `post-compact.ts`, `dispatch.ts`) — Codex parses these hooks' stdout with `deny_unknown_fields` (codex-rs/hooks `schema.rs`: universal keys only, plus `decision`/`reason` for SubagentStop). The harness returned `{"message":…}` and `hookSpecificOutput.additionalContext` on SubagentStop, and top-level `additionalContext` / `hookSpecificOutput` on PreCompact/PostCompact, so Codex failed with "hook returned invalid subagent stop hook JSON output". For the `codex` adapter only, the same text is now emitted as `{"systemMessage":…}`; `dispatch.ts` passes the adapter id through. Every other harness is byte-identical. Verified in a live Codex session (codex-cli 0.157.1) with forced compaction and real subagents: 1869 hook calls captured at the binary entry, 0 schema violations, 0 non-zero exits.
- **SubagentStart no longer crashes on an APEX `task.json` without `tasks`** (`src/runtime/lifecycle/aipilot/inject-apex.ts`) — `Object.entries(undefined)` made the hook exit 1 when `task.json` had no `tasks` object (e.g. `{}`). It now reports `none` for completed/pending tasks; valid files are unchanged. All harnesses. Tests: 1883 to 1892 (+9, no existing test modified).

## [0.1.97] - 2026-09-08

### Added

- **Project-aware verification hint** (`src/runtime/lifecycle/receipt-hint.ts`) — the `TaskCompleted` refusal used to list every ecosystem's commands regardless of project. It now names only the commands of the ecosystem detected for the project: root markers in the working directory and in the first two path segments of the files changed in the session (monorepos), plus the extensions of those files. `bun test`/`bunx tsc` on a Bun repo, `npm`/`pnpm`/`yarn test` per lockfile, `pytest` with `mypy`/`pyright` when configured, `go test`/`go vet`, `cargo test`/`cargo check`, `php artisan test`/`phpunit`/`pest` with `phpstan` when configured, `swift test`, `flutter test`/`dart test`; the generic list only when nothing is detected. The `SubagentStop` advisory uses the same hint. A single shared code-extension list (`code-extensions.ts`) now feeds session change tracking, the completion gate, and the hint — Dart files were gated but never tracked, so the Dart branch could not fire; fixed. Paths from session state are confined to the working directory before any disk read; search directories are deduplicated. Verified on 30 real fixture projects through the hook binary. Tests: 1837 to 1857.

## [0.1.96] - 2026-09-07

### Added

- **Verification receipts for 20 tools across 7 ecosystems** (`src/tracking/receipt-runners.ts`, `receipt-runners-parse.ts`, `receipt-runners-parse-php.ts`, `receipt-runners-parse-static.ts`, `src/tracking/receipt-command.ts`) — the TaskCompleted receipt gate previously only recognised `tsc` and `bun test`/`vitest`/`jest`/`npm test`, matched anywhere in the raw command, so Python, Go, Rust, PHP, Swift and Dart projects could never satisfy it and a commit message merely mentioning `jest` forged a receipt. Now a runners table covers `bun test`, `vitest`, `jest`, `npm`/`pnpm`/`yarn`/`bun run test`, `pytest`, `go test`, `cargo test`, `phpunit`, `pest`, `php artisan test`, `swift test`, `dart`/`flutter test`, plus `tsc`, `mypy`, `pyright`, `phpstan`, `go vet`, `go build`, `cargo check`, `cargo clippy`, `swift build`, each with a per-tool summary parser calibrated on real output (cargo pads `Finished` to 12 columns, `pytest -q` prints an undecorated summary, PHPUnit's OK-but banners count skipped tests in `Tests`). Commands are matched on the quote/heredoc-stripped text, anchored at command position, with the runner required to be the last command of the list; redirected or piped-away output is not evidence, no-run and informational flags never count, and a receipt now needs positive evidence — tests executed above zero with zero failures, the tool's own success line, or documented silence with intact output. A missing exit code means no capture. This is a guard against forgetting to verify and against honest shortcuts, not a security control against deliberate output fabrication. `bash-command-anchor.ts` now exports its parts (`CMD` unchanged); gate messages were generalised for the new tool set. Tests: 1779 to 1837.

## [0.1.95] - 2026-09-06

### Fixed

- **HMAC key directory resolved lazily** (`src/tracking/integrity.ts`) — it previously captured the journal signing key/nonce directory from `os.homedir()` once at import time. On Linux, `os.homedir()` follows a mutated `HOME` at call time, so a child `bun` process spawned by `test/track-journal-toctou.test.ts` after another test suite temporarily redirected `HOME` signed its journal events with a key under that tmp `HOME`, while the parent verified against the key captured at import — the child events were rejected as a total loss. macOS Bun ignores a mutated `HOME` in `os.homedir()`, which is why this never reproduced locally; `bun test`'s file run order changed with the 2026-08-31 runner image update, which is what turned this red in CI. `integrity.ts` now resolves the key and nonce paths lazily at call time, and `test/lessons.test.ts`, `test/lessons-session.test.ts`, `test/lesson-compact.test.ts` restore `HOME` in `afterAll`.
- **Codex `apply_patch` SOLID size gate computed the post-patch line count wrong** (`src/policy/edit-outcome.ts`, `src/adapters/codex/apply-patch.ts`) — the gate now simulates the patch on the real file content (`computePatchResultLines`) and reuses the strict-shrink policy already shared with Claude Edit, instead of a hunk-delta arithmetic that inherited a file-vs-hunk final-newline mismatch. 205 to 199 and 205 to 204 stay allowed, 205 to 206 and 199 to 201 are refused, an invalid patch is refused. The Codex guidance message now describes the `apply_patch` procedure instead of telling Codex to switch tools. Claude path unchanged.

### Added

- **Inline-script writes now gated on every target** (`src/policy/guards/bash-write-inline.ts`, `bash-write-lexer*.ts`) — `bun -e` / `node -e` / `tsx -e` / `deno eval` / `ruby -e` / `perl -e` and stdin forms (`bun -`, `node -`, `ruby -`, `perl -`) that write a code file are blocked like redirections, on Claude, Codex, Kimi, and Cursor alike. A new single-pass shell lexer skips quoted strings, heredoc bodies, comments, arithmetic, and tracks command substitution, so commit/PR bodies that merely mention these commands are never blocked (68 canonical Claude Code commit/gh forms verified at main parity; 300-case corpus: 0 loosened vs main). Dead `stripQuoted` removed.

## [0.1.94] - 2026-09-03

### Added

- **Lead `Stop` compact hint** (`src/runtime/prd/prd-stop-gate.ts`) — when the coordinator's Stop fires with no unresolved cross-check violation and at least one task is fully validated but not yet compacted, emits a one-shot, non-blocking reminder naming the task(s) and the `harness prd compact <task>` command. No PRD write; compaction stays an explicit, agent-identity-bound command.

### Fixed

- **PRD support matrix (docs)** — the 0.1.93 matrix incorrectly listed the lead `Stop` block as functional on claude-code. claude-code's and Kimi's own marketplace `Stop` hook of scope `core` always passes `--sound stop`, and `src/cli/bin.ts` exits 0 in `maybePlaySound()` before stdin is read, so the gate is never reached on either target. `docs/prd.md` and `docs/adapters.md` now name that wiring cause and separate it from the gate itself, verified correct whenever actually invoked.

## [0.1.93] - 2026-09-03

### Added

- **Opt-in multi-agent PRD ownership coordination** (`src/prd/`) — coordinates file/task ownership across multiple sub-agents working from a shared PRD, entirely inert by default: requires both `FUSE_PRD=1` and a routing file (`apex/prd.json`) present before any behavior activates.

## [0.1.92] - 2026-09-02

### Fixed

- **Cursor native adapter hardening** (`src/adapters/cursor/`, `src/runtime/handle.ts`, `src/runtime/lifecycle/{rules-root,aipilot/dispatch-aipilot,failure-lesson}.ts`) — plugin-root discovery now follows an explicit precedence (`CURSOR_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → cwd marker) with a stderr diagnostic on miss, and project cwd resolution honors `CURSOR_PROJECT_DIR`/`CLAUDE_PROJECT_DIR`. Scope dispatchers now receive a canonical payload projection (`tool_name`, `cwd`, `tool_input` coerced string→object), and `MCP:<tool>` names are canonicalized via a closed server table. The doc-cache gate is now reachable on `beforeMCPExecution` under a cursor-only guard. Added per-event native response schemas with an exhaustive renderer, plus an `additional_context` 10,000-char cap backed by a session-level budget ledger (keyed `session|event|generation|tool_use_id`, fail-open, idempotent truncation). Covered by 23 provenance-labelled fixtures and byte-level stdout tests; test hygiene improved (tmp cwd/HOME, env restore, hex-free nonce for a pre-existing flake).

## [0.1.91] - 2026-09-01

### Fixed

- Complete native Cursor hook handling and harden confirmation and shell-write enforcement.

## [0.1.90] - 2026-08-12

### Fixed

- **Codex-mangled MCP tool names silently broke the design gate, APEX freshness credit, and doc-cache gate** (`src/runtime/mcp-tool-name.ts`, `src/runtime/normalize.ts`, `src/adapters/codex/index.ts`, `src/runtime/lifecycle/aipilot/{doc-cache-gate,cache-doc,dispatch-aipilot}.ts`) — Codex CLI globally rewrites every `-` to `_` across the qualified MCP tool identifier before it reaches any hook (`sanitize_responses_api_tool_name()`, openai/codex#14605 — Code Mode exposes tools as TypeScript identifiers, where `-` is illegal). This harness compared against the hyphenated form everywhere, so on Codex only: `SHOT_TOOLS.has()` always missed (design pipeline stuck at phase 1), `classifyExplore` never credited `research-expert` (APEX freshness gate), and the doc-cache gate never fired. New `canonicalizeMcpToolName(id, tool)` — a pure function guarded by `id !== "codex"` first, two closed null-prototype tables (`Object.create(null)`, server-scoped `TOOL_ALIASES` to avoid corrupting segments with a legitimate underscore) — wired into all 5 ingestion paths. Verified against a 660-line before/after characterization (15 harness ids × 44 tools): 12 lines changed, all `id: "codex"`, zero regression elsewhere. Confirmed live on Codex 0.147 — a real `design-expert` subagent session now reaches `screenshotsCount: 5` and completes the identity phase.

## [0.1.89] - 2026-08-03

### Security

- **Arbitrary command execution via a crafted staged filename in `harness check`** (`src/cli/run.ts`) — `stagedContent()` built a shell command string via `execSync(\`git show ":${path}"\`)`, with `path` taken directly from the literal name of a staged file, fully controlled by whoever authored the commit. Git's `core.quotepath` escapes an embedded `"` or `\`, but not backticks or `$(...)`, so a filename like `` x`touch pwned.txt`.ts `` ran as shell syntax. Anyone running `harness check` as a pre-commit hook (the README's own documented usage) against an untrusted staged file list — e.g. right after `git add .` on a checked-out contributor branch — got arbitrary command execution. Both `stagedContent()` and `stagedFiles()` now use `execFileSync` with an argv array; the filename reaches `git show` as a single literal argument and is never parsed by a shell. Reported in [#87](https://github.com/fusengine/harness/issues/87) by @VikramNehreTR, with reproduction, root-cause analysis, and the exact fix adopted here. A non-regression test exercises the real `stagedContent()` against an isolated repo with a backtick-laden filename, proven discriminating against the vulnerable form. All 9 execution sites in `src/` were audited for the same shape; this was the only exploitable one.

## [0.1.88] - 2026-08-03

### Added

- **`CONFIRM <code>` recourse for `ask` prompts degraded to deny on Codex/Kimi** (`src/runtime/confirm/`) — `permissionDecision: "ask"` is ignored by both host harnesses: Kimi Code's own binary shortcuts on `if (hookSpecificOutput?.permissionDecision !== "deny") return result`, and Codex fails a hook open when it returns `ask` in the unsupported shape, so the harness was downgrading every `ask` to a hard `deny` with no recourse (Claude Code is unaffected — its native `ask` still shows an interactive confirmation, and no code ever appears in its messages). The deny message for a downgraded `ask` now appends a short 4-hex-char code; retyping `CONFIRM <code>` in the next prompt authorizes that exact action once. Covers every guard that can produce an `ask` with a command attached (git routine ops, install, bash-write, security) via one central hook in the PreToolUse pipeline (`src/runtime/handle-pre.ts`), not a per-guard change. Guardrails: no token can be placed while a sub-agent is active (G0, session-scoped, structurally impossible from inside a Task/Agent call since sub-agents never receive their own `UserPromptSubmit`); a token is consumed on first use (G1); a token expires after 5 minutes (G2); the token is keyed to the action's full SHA-256 hash, never the 4-char display code, which exists purely for the human to retype and collides by design (G3); irreversible commands (`push --force`, `reset --hard`, `rm -rf`, `git clean -fd`, `branch -D`, …) are never confirmable — they stay a hard deny regardless of a valid token (G4); an explicit refusal in the next prompt drops any pending token (G5). New env var `FUSE_CONFIRM_SUBAGENT_WINDOW_SEC` (default `300`, seconds) tunes the G0 cool-down without a rebuild. **Scope, stated plainly**: this is a guard against accidental/hasty denial-with-no-recourse, not a security control against an adversarial agent — any agent with arbitrary shell access can write the token directly into the session-state file it authorizes from and self-approve, exactly as it could bypass any other stateful gate this harness keeps outside a sandbox.

### Changed

- **`python3 -c` is now judged on its content, like `node -e` already was** (`src/policy/guards/bash-write-patterns.ts`, `bash-write.ts`) — previously every `python3 -c '...'` invocation was blocked outright, regardless of what the script did. The inline script is now scanned for actual file/process mutation (`open(..., 'w'/'x'/'a'/...)`, `pathlib.Path` mutators, `shutil`/`os` mutators, `subprocess.*`, `pickle.dump`/`json.dump`, `exec`/`eval`, …); a read-only one-liner (`python3 -c 'print(1)'`, `json.loads(...)`) now passes, and a mutating one (`python3 -c 'open("x","w").write(...)'`) still blocks. `python3 - <<EOF` (heredoc) is unaffected and stays unconditionally blocked — a heredoc body isn't reliably inspectable with a single-line regex.

### Fixed

- **Kimi's array-shaped `prompt` field was silently read as empty** (`src/runtime/prompt-text.ts`) — Claude Code and Codex send `prompt` as a plain string, but Kimi 0.31.1 sends an array of content blocks (`[{"type":"text","text":"..."}]`) on `UserPromptSubmit` — measured live. Every prompt-based detection (creation-intent, CONFIRM parsing, mode detection) was reading `""` under Kimi as a result. A new `promptText()` helper normalizes both shapes: a string passes through unchanged (byte-identical for Claude Code/Codex — the identity branch that guarantees zero regression there), an array is flattened by joining each block's `.text` with `"\n"`.

## [0.1.87] - 2026-07-30

### Fixed

- **Kimi Code CLI dumped the full rules corpus and root `AGENTS.md` into the terminal on every prompt** (`src/runtime/inject-context.ts`, `src/runtime/lifecycle/inject-rules.ts`, `src/runtime/lifecycle/kimi-rules-native.ts`) — Kimi has no model-only channel for hooks: on exit 0, hook stdout is both fed to the model's context *and* echoed raw to the terminal. The ~18 KB rules corpus and root `AGENTS.md` were therefore printed to the user on every `UserPromptSubmit`, even though Kimi already loads `AGENTS.md` natively. Now only the notice is emitted on `UserPromptSubmit`, with a fail-safe: missing fences or an unreadable file fall back to emitting the full corpus (never silently drop rules). `SessionStart`/`SubagentStart` are unaffected and keep emitting the full corpus. Verified zero regression on claude-code/codex/gemini-cli via a 32-cell characterization golden captured before the fix (`test/inform-matrix.characterization.test.ts`).

## [0.1.86] - 2026-07-29

### Fixed

- **Design pipeline dropped screenshot and corpus-read counts it should have credited** (`src/runtime/design-helpers.ts`, `src/policy/design/screenshot-tools.ts`, `corpus-resolve.ts`, `corpus-fs.ts`, `corpus-resolve-cache.ts`, `gates.ts`, `allowed-write.ts`, `corpus.ts`, `src/policy/detect-framework.ts`) — a real `design-expert` run had captured 3 screenshots and read 5 corpus files, yet the pipeline reported `screenshotsCount:0, corpusReads:[], currentPhase:1`, so the phase-2 gate never opened. Root cause: corpus resolution only recognized the `marketplaces/<mkt>/plugins/design-expert` tree, not the `cache/<mkt>/<plugin>/<version>/` tree Claude Code also serves (where the plugin is named `fuse-design`) — now detected structurally by corpus suffix, never a hardcoded name, with marketplace priority and `maxSemver` selection. Alongside: `browser_shots_batch`/`browser_site_shots` now credit the screenshot quota (previously only `browser_screenshot` did); the write gate now allows `motion*.js` by basename (all eleven corpus references ship one); reference `design-system.md` sheets now credit as a new `"sheet"` `CorpusKind` (without counting toward the `tokens-*` threshold that the `full` quota requires); `.css` files are classified `tailwind` only when their content matches known Tailwind markers, not by extension alone.

### Changed

- **`full` corpus quota raised to README + 3 tokens** (was 2) (`src/policy/design/corpus.ts`) — owner-arbitrated; `page` and `component` quotas unchanged.

## [0.1.85] - 2026-07-29

### Fixed

- **Typo gate missed quoted font names in non-English custom properties** (`src/policy/design/design-system-rules.ts`) — the gate only recognized typography custom properties by an English keyword in the property name (`--*font*`/`--*ff*`/`--*type*`), so a token named in French like the corpus's `--police-texte: "Inter", …` (`refs-design/linear-recode/styles.css`) slipped through unbanned. `FONT_QUOTED_PROP_RE` now flags any `--*` custom property whose value quotes a forbidden name, using the quote itself as the usage signal instead of an English keyword.

## [0.1.84] - 2026-07-29

### Added

- **Local design corpus as the source of taste** (`src/policy/design/corpus.ts`, `corpus-resolve.ts`, `design-system-rules.ts`, `template-urls.ts`, `src/runtime/design-content-gate.ts`, `design-files-gate.ts`) — the `design-expert` plugin produced generic, interchangeable pages because its inspiration phase browsed ~100 Framer/Webflow templates. The harness now executes the corpus doctrine instead: corpus resolution per runtime (Claude marketplace tree vs Codex `plugins/cache/<mp>/<plugin>/<version>/`, semver-selected, no `process.cwd()` fallback), corpus reads recorded as state progression, and a citation↔read join tolerant of both naming conventions and both layouts. The template-platform allowlist is inverted into a frozen denylist — reviving it would resurrect the doctrine this replaces.

### Changed

- **Design quotas** (`src/policy/design/state.ts`, `transitions.ts`, `gates-pipeline.ts`) — at least one screenshot in every mode, always; with the corpus present, `{ full: 2, page: 1, component: 1 }` plus the corpus reads. Corpus absent leaves the requirement waived (pre-doctrine quotas), so the branch stays dormant until `refs-design/` ships to the marketplace.
- **`apply_patch` brought into the design pipeline** (`src/runtime/design.ts`, `design-helpers.ts`, `handle-pre.ts`, `handle-post.ts`) — Codex's patch primitive now passes the PRE path/phase/quota gates; `op:"add"` is validated as a `Write`, `delete` is skipped, and `cwd` is wired so the POST re-reads the real file rather than the hunk. The POST is promote-only: a clean file promotes to phase 3, a dirty one changes nothing.

### Fixed

- **`pluginsWriteGuard` bypass on relative paths** (`src/runtime/pre-allow.ts`) — the guard anchored on absolute paths only; `corpusRoot` and `pluginsRoot` are now resolved independently, so a corpus override no longer decides where plugin writes are allowed.
- **Substitution bypass in the design content gate** (`src/runtime/design-files-gate.ts`) — `String.replace` treats `$&`, `` $` ``, `$'` and `$$` as substitution patterns; literal replacement now goes through `replace(from, () => to)` / `split().join()`, closing all four quadrants.

## [0.1.83] - 2026-07-24

### Fixed

- **Append/compaction TOCTOU lost-write in the event journal** (`src/tracking/track-journal.ts`, `src/tracking/track-lock-sync.ts`) — `appendEvent` used a bare `appendFileSync` with no mutual exclusion against the compactor's rename→fold→unlink; an append straddling open→write during compaction could land in the renamed inode and be silently unlinked. `appendEvent` now serialises on `withTrackLockSyncBlocking`, a blocking twin of the existing non-blocking lock (spins on `track.lock`, stale-lock TTL as the only anti-deadlock guard, never skipped), the same lock the compaction takes — zero lost write. Deterministic, non-vacant probes (`test/track-journal-toctou.test.ts`): a manually-held-lock block test, and a real `appendEvent` loop racing a real `maybeCompactJournal` with zero event loss asserted.

## [0.1.82] - 2026-07-24

### Added

- **Lock-free append-only event journal for `SessionTrack`** (`src/tracking/track-journal.ts`, `src/tracking/track-diff.ts`, `src/tracking/track-compact.ts`) — writes append events instead of read-modify-write on the shared state file, eliminating the write-skipped outcome under concurrent multi-agent fan-out. Kill-switch `FUSE_TRACK_JOURNAL=0` reverts to legacy read-modify-write; `FUSE_TRACK_COMPACT_BYTES` tunes when compaction fires; compaction rewrites the journal into a fresh state file via atomic rename. Guarantees: G1 append never skipped under fan-out, G2 replay deterministic/idempotent, G3 compaction crash-safe, G4 legacy behavior preserved byte-for-byte with the kill-switch off. Validated in real conditions (deployed dist, multi-agent fan-out, 0 write-skipped, 24/24 runs without loss, clean migration from legacy state).

## [0.1.81] - 2026-07-23

### Fixed (hotfix — CI stabilization)

- **HMAC key race on virgin `HOME` (CI red)** (`src/tracking/integrity.ts`) — `loadOrCreateKey` now creates the per-machine `.key` atomically (`wx` flag crowns one creator among N concurrent first-time processes) instead of each racer signing with its own key, and throws on a still-empty key after bounded contention retries instead of returning silently.
- **`track-lock` concurrency test flaked in CI** (`test/track-lock.test.ts`) — the 8-worker write test now pins a hermetic `HOME` shared with a same-`HOME` verifier worker; the parent process previously froze `HARNESS_DIR` at import while neighbouring tests mutated `process.env.HOME`, so workers signed under a `HOME` diverging from the verifier's and every write was rejected.

### Added

- **Solid scope: PreToolUse file-size deny, tri-harness** (`src/runtime/solid-file-size-gate.ts` + `src/runtime/solid-pre.ts`) — `harness hook <id> solid` now blocks oversized Write/Edit with the exact policy of core's `evaluate.ts` (strictly-shrinking Edit passes, Explore/Plan exemption, `FUSE_SOLID_MAX_LINES` honored) but WITHOUT the core-only APEX freshness gates, and renders via `respond()` so kimi receives its native `hookSpecificOutput` deny instead of nothing. Intentional behavior change for claude-code/codex: the solid scope previously only warned PostToolUse (that warn remains). Sim scenario `40-kimi-solid-filesize-deny`.
- **Kimi: APEX task-context trigger on `Agent`/`AgentSwarm`** (`src/runtime/is-agent-tool.ts`) — the PreToolUse dispatch branch tested `event.tool === "Task"` (claude/codex), so the injection never fired for Kimi's sub-agent tools. Sim scenario `41-kimi-agent-task-context`.
- **Kimi: MCP/WebFetch cache-hit deny** (`adapters/kimi::kimiDenyResponse`, `runtime/mcp.ts`) — a fresh cache hit now denies with the cached body through the documented envelope (no `hookEventName`); input mutation stays unsupported (Kimi documents no `updatedInput`), so the exa verbosity cap remains inoperative there by design.
- **Kimi: lifecycle injections rendered natively** (`src/runtime/inform.ts`) — rules, lessons, and the CLAUDE.md preamble go through `renderInform`: raw text on stdout for kimi (appended to context on exit 0) instead of the Claude-shaped envelope Kimi ignores; every other harness is byte-identical (associative `attachSystemMessage` merge preserved). The rules plugin root now resolves dynamically (`src/runtime/lifecycle/rules-root.ts`): `CLAUDE_PLUGIN_ROOT` → `KIMI_PLUGIN_ROOT` → per-harness install probe (claude marketplace, codex versioned cache — latest version, kimi managed plugins) → `cwd`. Sim scenario `42-kimi-rules-userprompt-inform`.
- **Kimi: `KIMI_CODE_HOME` honored** (`src/config/home-dir.ts`) for the harness-home `.env` probe; other harnesses ignore it, defaults unchanged.
- **CLI: unknown hook scope warns on stderr** (`src/cli/scope.ts`) instead of silently falling back to `"core"` — the fallback stays for wiring compatibility, stderr is never parsed by harnesses. `bin.ts` split under the 100-line ceiling (`src/cli/hook-io.ts`).

### Fixed

- **Duplicate file-size deny when core-guards AND solid are both wired** (`src/runtime/core-guards-wired.ts`) — the solid scope now abstains from its PreToolUse file-size gate when the core-guards plugin is detected (claude marketplace / codex versioned cache / kimi managed plugins): one tool-call, one deny, core stays the primary owner. Single-scope behavior is unchanged on both sides (test `dedup: core-guards installed -> solid abstains, core denies — exactly ONE deny`).
- **Solid abstention could mean ZERO deny when core-guards is installed but disabled** — `core-guards-wired.ts` now probes the REAL activation state per harness (`core-guards-active.ts`: claude `settings.json` `enabledPlugins` — required core = no entry means active, explicit `false` disabled; codex `[plugins."core-guards@…"] enabled` in `config.toml`; kimi `installed.json`). Anything undetectable reads as NOT active: the solid scope fires, worst case a duplicate deny, never zero (owner decision; test "installed but DISABLED -> solid fires").
- **Agent-dispatch recognition drifted across a fourth copy** — `freshness/agent-evidence.ts` (transcript scan) matched `Task`/`Agent` inline and missed `AgentSwarm`; it now consumes the canonical `AGENT_TOOLS` set, and the consumers lock test greps all three files.
- **compareSemver NaN on prerelease segments** — `Number("0-beta")` is NaN, leaving `sort()` undefined; non-integer segments now compare lexicographically (identical strings → 0), JSDoc corrected, sort-stability test added.
- **Codex rules probe picked stale versions** — `rules-root.ts` sorted version dirs lexicographically (`"1.0.9" > "1.0.23"`); now orders by numeric semver (`src/util/semver.ts`, zero-dependency).
- **Agent-tool detection duplicated** — `freshness/agent-evidence-record.ts` and `runtime/activity.ts` kept their own `Task`/`Agent`/`AgentSwarm` definitions; both now consume `runtime/is-agent-tool.ts` (single source). The file-size logic twin (`evaluate.ts` frozen vs `solid-file-size-gate.ts`) is locked by a bidirectional anti-drift test (`test/anti-drift-file-size.test.ts`) that fails if either side drifts.
- **Kimi: forged verification receipts** (`src/runtime/receipt-capture.ts`) — PostToolUse Bash receipts are recorded only from structured responses; Kimi's truncated string `tool_output` no longer produces `exit 0` success receipts for possibly-failed runs.
- **Kimi: Claude-shaped `extra` leak in PostToolUse** (`handle-post.ts`) — the kimi branch no longer inherits the unparseable post-edit envelope.

### Added (conventions module — Patch E)

- **Store conventions gate (Zustand/Pinia, advisory-first)** — signature-strict detection (zustand import or v5 curried `create<T>()(`, pinia import + `defineStore(`; `Object.create`/home-made factories never match): store declared outside `stores/` → advisory, store file over `storeBudget` (ratio 0.4 of the global limit, born with its consumer) → advisory.
- **TanStack Query conventions gate (cap-gated)** — a `useQuery`/`useMutation`/`useInfiniteQuery` definition in a component/page → advisory "Move to src/query/", only when `@tanstack/react-query`/`vue-query` is in the nearest manifest; `query/` and `hooks/` are both accepted homes.
- **Components rule (deterministic case)** — a `.tsx/.vue` component inside `src/hooks|stores|query|interfaces|types/` → advisory "Move to modules/[feature]/components/".
- **Extended interface syntaxes wired (advisory-first)** — Swift `public protocol`, Kotlin `sealed`/`fun interface`, unexported Go top-level interface (`interface-separation-ext.ts`); legacy verdicts byte-identical (exact-JSON assertions).
- **Self-reference hardening** — `SELF_GATE_EXCLUDE_RE` now covers `framework-solid-extended.ts`, `detect-framework.ts`, and all of `src/policy/conventions/`; store/query-definition files are exempt from the legacy hook-location rule (they are not hooks).

### Added (conventions module — anti-loop, in-vivo Laravel)

- **SubagentStop SOLID-notice dedup** (`aipilot/solid-notice.ts`) — the stateless checker re-emitted identical violations on every SubagentStop (observed ~15-repeat agent loop). A SHA-256 fingerprint of the sorted file:message set is persisted per agent key in `.harness/track/solid-notice.json` (canonical layout entry, sync-locked write, TTL derived from `FUSE_ENFORCE_TTL_SEC`): unchanged set → silence; changed/expired → one emission.

### Fixed (conventions module — G, in-vivo)

- **Idiomatic generic forms were invisible** — `create<CartState>((set) => …)` (and nested `create<Store<T>>(`) now match the Zustand declaration, `useQuery<T>({…})`/`useMutation<Data, Error>({…})`/`useInfiniteQuery<T>({…})` the query definition; `Object.create`/home-made factories still never match.
- **`Contracts/` flagged as an interface violation (Laravel in-vivo)** — `app/Contracts/` (both casings) is now exempt alongside `interfaces/`/`types/`, and flagged `.php` files get the `app/Contracts/` destination message (laravelGate parity).
- **Directory matchers were unanchored substrings** — `app/` matched `livetest-app/`, `views/` matched `reviews/` (and `view/` matched `overview/` in the interface guard). All segment-anchored (`solid-transcript.ts`, `solid-compliance.ts`, `interface-separation.ts`'s `inAny`), and `/interfaces/` + `/types/` are exempt by owner decision (canonical homes never violate).

### Fixed (H1 — in-vivo Next.js runtime crash)

- **Marker-less client components escaped the `'use client'` rule** — `jsViolations` routed nextGate/reactGate by CONTENT (`NEXT_RE`), so a bare client component (`useState`, no `next` marker) in a Next.js app went to reactGate, landed without the directive, and crashed at runtime. Routing is now MANIFEST-FIRST (`src/policy/js-gate-route.ts`, per-process memoized manifest capabilities): a project declaring `next` always gates with nextGate; `react`/TanStack Start projects gate with reactGate; no JS-framework capability (no manifest, backend, vue) falls back to the legacy content routing, byte-identical. Consequence accepted by spec: in a next-manifest project the legacy react hook-location rule no longer applies (everything routes to nextGate, which never had it — legacy coverage was marker-dependent).

### Changed (H2 — gate message wording, byte-parity broken on 3 messages)

- **Design skill-consult deny** — `Read the SKILL.md for: X` → `Read the SKILL.md FILE (with the Read tool) for: X`: invoking the skill via the Skill tool leaves no receipt; only a Read of the file credits (`src/policy/design/skill-gate.ts`).
- **APEX refs denies** (`apex-gates.ts`, `apex-authorization.ts`) — now say `Read ALL references below (including Optional), then retry`: the credit needs the full routed set and the old wording never said so.
- **Deny-loop repeat prefix** (`deny-loop.ts`) — `STOP: do not retry this same call.` → `Do not retry this same call UNCHANGED — if you have since completed the required reads/actions, retry now; otherwise STOP and pick a DIFFERENT approach.`: the counter cannot know about new reads, so the hard STOP is reserved for the unchanged retry (a legitimate retry after new reads was being discouraged). Text only — no credit-logic change anywhere.

### Fixed (hardening — F2, final counter-audit)

- **`readBounded` head corruption on multi-chunk payloads** — chunk views into the reused read buffer were overwritten, so an oversize payload's head lost `hook_event_name` and observation-only events were denied instead of neutral. Chunks are now copied; a >64 KiB multi-chunk test proves head readability and the neutral PostToolUse path.
- **Last two track RMW races closed** — `recordCodexSpawnEvidence` (async `withTrack`) and `harvestSubagentTrack` (new synchronous lock variant `track-lock-sync.ts` using `Atomics.wait`, required because the SubagentStop dispatch cannot float async work) now run under the track lock.

### Added (hardening — F2, final)

- **Bounded stdin for `harness hook`** — `readBounded` never buffers past `FUSE_HOOK_STDIN_MAX_BYTES` (default 16 MiB; the mission's only new env var, owner-approved). Oversized payloads fail CLOSED: a native deny (`denied uninspected`) on blockable/undeterminable events, neutral silence on observation-only ones. Largest legitimate payload measured at 3,757 bytes across the sim suite.
- **Session-track lock** (`tracking/track-lock.ts` + `withTrack`) — the read-modify-write of `loadTrack → mutate → saveTrack` is now serialized across the ~11-hook fan-out (`wx` lockfile, 400 ms total retry budget, named skipped write on contention instead of a crash, 10 s stale-lock reclamation). Proven: 8 concurrent processes × 3 writes, zero loss; degradation path renders its decision with a stderr note. The 5 RMW call sites (record, receipts, handle, gate-apex, agent-evidence-record) migrated.

### Fixed (hardening — F2)

- **`parseScope` warned on the explicit default** — `hook <id> core` no longer logs the unknown-scope warning (only genuinely unknown scopes do).

### Changed (conventions module — F1)

- **`FUSE_CONVENTIONS_MODE` default inverted to `deny`** (owner decision): new convention rules block by default; `advisory` is now the explicit opt-out observation mode. Docs: `docs/conventions.md` (full conventions reference: canonical structure, rule matrix, env vars, voluntary gaps).

### Fixed (conventions module — F1)

- **Every legitimate Next.js client component was denied** (F1.1, blocking): the `'use client'` directive check ran on masked content, and the directive is a string literal — it now reads comment-masked content only, so a real directive (either quote form) passes while `// "use client"` still fails.

### Fixed (conventions module — F0 counter-audit)

- **reactGate masked the store imports it probed** (F0.1, blocking): `content` was masked BEFORE `declaresStore`, so the `from "zustand"/"pinia"` import literal was blanked and plain stores were hard-denied into `hooks/` even inside `stores/`. New `maskCommentsOnly` (comments masked, strings kept) drives the import probes; gates pass raw content to the store/query detectors.
- **Hook exemption was not cap-gated** (F0.2): a fake `useQuery(` caller without `@tanstack/*-query` in the manifest escaped every rule; the exemption now requires a validated signature AND the cap (shared `conventions/store-or-query.ts`), otherwise the legacy hook rule fires byte-identically.
- **Self-gate regex matched a non-existent file** (F0.3): `framework-solid-gates(-systems|-extended)?` missed the real `framework-solid-extended.ts`; regex fixed, `guards/interface-separation-ext.ts` added, lock test asserts `isSelfGateSourcePath() === true` for all 10 detector sources plus a no-verdict pass on their real disk content.
- **Vue SFC invisible to the components rule**: `export default {}`/`defineComponent(` now count as component declarations and `.vue` enters the extended gate path.

### Fixed (conventions module — Patch E)

- **Hook-location rule shadowed store/query conventions** — `useAuthStore`/`useUsers` were hard-denied into `hooks/`; store- and query-definition files are now governed by their own advisory rules.

### Added (conventions module — D0 + Patch D)

- **Extended convention gate** (`src/policy/framework-solid-extended.ts`, advisory-first per `FUSE_CONVENTIONS_MODE`) — widened custom-hook location rule (`export default`/`async` syntaxes, nextjs/tanstack family), hook-file line budget (`hookBudget`, ratio 0.3 of the global `FUSE_SOLID_MAX_LINES` limit — 30 at the default, one variable drives every budget; owner decision: no per-file-kind env vars), TanStack Start route files kept routing-only.
- **`routeTree.gen.ts` hard-blocked** (generated TanStack Router artifact, owner Amendment 8).
- **Derived budgets** in `src/config/limits.ts`: `hookBudget` (ratio 0.3 → 30 at the default global limit); the store budget (ratio 0.4) ships with its consumer in Patch E — no dead code.

### Fixed (conventions module — D0 + Patch D)

- **strip.ts unmatched-quote FN** (external audit D0.1): a JSX apostrophe (`Don't`) opened a "string" that swallowed the rest of the file and hid real declarations; plain quotes now never span lines, and an unpaired backtick masks nothing.
- **validate-solid.ts rollout violation** (D0.2): Go `interface{` (no space) and Python `Protocol` were hard-denied outside the flag — now advisory-first; indented/local Go interfaces (a true false positive — a local type cannot move to `internal/interfaces/`) never match (column-0 anchor). Legacy stays hard deny, byte-identical (test asserts the exact JSON in both modes).
- **detect-framework tanstack signal read raw content** (D0.3): a comment citing `createServerFn` flipped a real Next.js file to tanstack-start; JS content signals now ride masked content.
- **Literal line limits** (D0.4): `nextGate`/`swiftGate` `? 150 : 100` → `resolveMaxLines()` base + 50 (defaults unchanged; override test at 80/130). Permanent rule: every size limit via `config/limits.ts`, every TTL via `config/ttl.ts`.

### Added (conventions module — Phase 1 patches A/B/C)

- **`src/policy/conventions/` module** (owner Plan v4 + amendments) — masked-content, per-language convention detectors, single source for the four historical interface layers: `strip.ts` (lexical comment/string/heredoc masking, line offsets preserved), `langs.ts` (language families, vendor exclusion, canonical path predicates for `interfaces/ types/ hooks/ stores/ query/ components/`), `interfaces.ts` (interface + exported-alias detection), `react-hooks.ts`, `stores.ts` (Zustand + Pinia), `query.ts` (TanStack Query), `verdict.ts` (advisory-first rollout).
- **Rollout flag `FUSE_CONVENTIONS_MODE=advisory|deny`** (default advisory, owner Amendment 5) — every NEW convention deny starts as non-blocking `inform`; existing denies keep their blocking behavior byte-identically.
- **Detection**: `projectCaps` reads `zustand`, `pinia`, `@tanstack/react-start|react-router|react-query|vue-query`; new `tanstack-start` framework label (first-class, Next.js-equivalent — `createFileRoute`/`createServerFn`/`@tanstack/react-*` signals, priority over generic react); SOLID_REF mapping `solid-tanstack-start/`.

### Fixed (conventions module — Phase 1 patches A/B/C)

- **Interface gates fired inside comments/strings/templates/heredocs** — all four layers (`interface-separation.ts`, `framework-solid-gates*.ts`, `validate-solid.ts`, `solid-compliance.ts`) now match on masked content; legitimate cases keep byte-identical messages (proven live: real Go/Python interfaces still denied with the legacy strings, comment-embedded ones allowed).
- **`validate-solid.ts` unanchored `class.*ABC`** — `class ABCParser` and comment mentions no longer denied; detection requires `class X(…ABC|ABCMeta|Protocol…)` masked.
- **`nextGate` `'use client'` regex** — word boundaries; `onChangeHandler`/`useStateMachine` no longer flagged.
- **`solid-compliance.ts`** — vendor/build dirs excluded; per-extension matching (no TS regex on `.py`, no PHP regex on `.ts`).
- **Exported type aliases in components** — redirected to `modules/[feature]/src/types/` with a dedicated message (owner Amendment 2), advisory-first, instead of the interfaces/ message.

## [0.1.80] - 20-07-2026

### Added

- Kimi Code adapter (7th target): `.kimi-code` home, subpath `@fusengine/harness/adapters/kimi`, detection via the `AGENT=kimi` / `AI_AGENT=kimi` standards (Kimi documents no dedicated session env var). Blocking events `UserPromptSubmit`/`PreToolUse`/`Stop` deny through the camelCase `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":…}}` channel on stdout at exit 0 — the only decision Kimi documents, and verified live against kimi-code v0.27.0 (the command never ran, the reason was re-injected to the model; exit 2 with stderr = reason also blocks but is not required) — so `ask` is downgraded to `deny` prefixed `[downgraded from ask — Kimi Code has no interactive approval]` (a hook cannot reach Kimi's parallel `[[permission.rules]] decision = "ask"` system) and `inform` rides plain stdout at exit 0, never wrapped in JSON. The 13 lifecycle events are delivered but their responses ignored; Kimi is fail-open by design (any exit code other than 0/2, a timeout, or a crash allows). No `harness init` runner: hooks live only in the global `~/.kimi-code/config.toml`, outside `init`'s project-local model — a copy-paste TOML snippet ships in `docs/adapters.md`, with the hard constraint that a `[[hooks]]` entry must emit nothing beyond `event`/`matcher`/`command`/`timeout` (validate the hand-written config with `kimi doctor`, the official checker). Live-tested end to end against kimi-code v0.27.0 on `PreToolUse`/`Bash` — deny and allow both honoured; the payload also carries an undocumented `tool_call_id` the harness ignores. `Write`/`Edit` `tool_input` field names, the `inform` stdout-to-context path, and the non-`PreToolUse` events stay unverified. Named `Agent`/`AgentSwarm` delegation launchers are credited toward freshness/activity evidence, but the custom-agents resolution path (`extra_agent_dirs`) under Kimi 0.28.1 has not been re-validated live and remains to be re-tested.

## [0.1.79] - 19-07-2026

### Added

- **`harness codex-rules` CLI command** — generates a Codex execpolicy Starlark `.rules` file (69 `prefix_rule` entries) derived from the exported guard constants in `src/policy/guards/security.ts` (`CRITICAL_PATTERNS` → `decision="forbidden"`, `ASK_PATTERNS` → `decision="prompt"`). Prints to stdout or writes to `--out <path>`. Includes a bidirectional anti-drift test (every source label covered by a rule or explicit skip-list entry, and every generated rule references an existing source label); the generated header documents irreducible gaps (fork bomb, raw disk redirect, `> /etc`, `curl | sh` installers) and assumed over-widths.

## [0.1.78] - 19-07-2026

### Added

- **Target-aware APEX builders (Claude vs Codex)** — `buildApexInstruction`, `buildApexTaskContext`, and `buildClaudeMdContext` (plus their `.claude/apex` folder resolvers) now branch on harness `id` via `HOME_DIR[id]` instead of hardcoding `.claude`/`CLAUDE.md`/`TaskCreate`. Under Codex, output routes to `.codex/apex`, `AGENTS.md`, and `update_plan` (drops the "triggers auto-commit" line). Under Claude Code, output is byte-for-byte identical to before (default `id` param unchanged, verified via a default-vs-explicit-id probe). New `src/policy/apex-target.ts` (helpers) and `src/policy/detect-claude-md-project-type.ts` (SOLID split).

## [0.1.77] - 18-07-2026

### Fixed

- **`TeammateIdle`/`TaskCompleted` "Invalid input" hook error** — both events reject `hookSpecificOutput` (contextResponse) on Claude Code 2.1.214; `teammate-idle-check.ts`, `teammate-idle.ts`, and `task-completed.ts` now ride the advisory, non-blocking `systemMessage` channel instead (the `Stop` path, which does accept `additionalContext`, is unchanged).
- **`PostToolUse` hook stamped as `PreToolUse`** — `respond()` gains an `event` param (default `"PreToolUse"`) propagated to all 4 branches; `handle-post.ts` now passes `"PostToolUse"` so `hookEventName` in the rendered stdout matches the event that actually fired.
- **Silent rules/context injection** — `attachSystemMessage` now merges (`\n`-joined) instead of overwriting when called more than once on the same stdout; `inject-rules.ts`, `inject-context.ts`, `session-start.ts`, and `lessons/dispatch.ts` (new `UserPromptSubmit` case) each attach a sober confirmation notice ("rules 00-08 injected", "CLAUDE.md injected", "lessons injected") so every prompt visibly confirms what was loaded.

## [0.1.76] - 17-07-2026

### Fixed

- **Design-system gate messages name the exact tool call** — the two `deny()` recovery messages in `designSystemWriteGate` now point explicitly at `mcp__fuse-browser__browser_screenshot` and note that `browser_shots_batch`/`browser_site_shots` do not count toward the screenshot quota nor advance the phase. Text-only; no change to gate logic, thresholds, or conditions.

## [0.1.75] - 17-07-2026

### Added

- **SOLID gates for Go and Rust** (`goGate`/`rustGate` in `framework-solid-gates-systems.ts`) — the framework-SOLID pipeline now covers systems languages alongside react/next/laravel/swift.
- **Module-aware interface placement** (`module-layout.ts`) — when an edited path sits under `modules/<name>/`, the 6 gates (react/next/laravel/swift/go/rust) now suggest the idiomatic per-module subfolder (`interfaces/`, `Contracts/`, `Protocols/`) instead of the flat project-root convention.

### Fixed

- **Auto-gate self-block** — `isSelfGateSourcePath` exempts the gate's own 2 source files by exact filename, so the SOLID gate no longer blocks edits to itself while detection on real code (e.g. a `.tsx` with a top-level interface) stays intact.

## [0.1.74] - 16-07-2026

### Fixed

- **`browserNavigateGate` no longer blocks localhost/file:// in phase >=2** — the `KNOWN_DOMAINS` catalog check now applies only during `state.currentPhase === 1` (inspiration browsing). It previously denied every `browser_navigate`/`browser_screenshot` call outside the catalog regardless of phase, which blocked design-review's visual pass (localhost/file:// URLs) in later phases.
- **`dispatchAipilot` cache home is now injectable** — new 5th param `home: string = homedir()`, threaded through the SubagentStart/SubagentStop cache handlers. Backward compatible (the sole prod call site relies on the default); lets tests isolate the lessons cache under a throwaway home dir instead of reading/writing the real machine-wide cache.

## [0.1.73] - 13-07-2026

### Fixed

- **Design pipeline: purge dead references to renamed skills** — the design gates still pointed at old numbered skill folders (`0-identity-system`, `1-designing-systems`) that were renamed to `design-system` / `design-web`. `transitions.recordRead` matched the substring `identity-system`, which no live skill carries anymore, so `currentPhase` never advanced past 0 and `browserNavigateGate` **denied every `browser_navigate` / `browser_screenshot` call forever**. The phase detector now matches `design-system/SKILL.md` (tightened to avoid over-matching the generated `design-system.md` output file), and `skill-triggers.ts` `readFragment`s/labels + `skill-gate.ts` `DESIGN_SKILL_RE`/message are realigned to the 9 real skill names.
- **Hermetic file-size tests** — 15 tests hardcoded ~150-line fixtures assuming the default 100-line ceiling, so they failed whenever `FUSE_SOLID_MAX_LINES` was overridden (e.g. `=200` from `~/.claude/.env`) and leaked into `bun test`. Fixtures now derive their size from the same exported `resolveMaxLines()` resolver the gate uses (`resolveMaxLines() + 50`); the suite is green for `FUSE_SOLID_MAX_LINES` = 100 / 200 / 300 / unset. No production code changed.

## [0.1.72] - 12-07-2026

### Fixed

- **Real `hookEventName` in rules injection** — `injectRules()` hardcoded `contextResponse("SessionStart", …)` (a verbatim port of the Python original), so the `claude-rules` scope emitted `hookEventName:"SessionStart"` on `UserPromptSubmit` and `SubagentStart` too. Per the Claude Code hooks spec the field must match the actual event, and a mismatched value risks being dropped on those non-SessionStart events (the ones that carry rules persistence per prompt / per sub-agent). `injectRules(pluginRoot, event)` now emits `contextResponse(event, …)`, and `dispatch.ts` passes `input.event` at its three call sites. Research confirmed the hardcode is not load-bearing (persistence is decided by *when* the hook fires, not the label), so this is spec conformance with no behavioral regression; `SessionStart` output is unchanged.

## [0.1.71] - 12-07-2026

### Fixed

- **Dynamic project-aware framework detection** — the framework of an edited file is now resolved from the real project on disk intersected with the file's own signal, replacing the extension-only classifier that labelled every `.ts` file "react" (because `\.tsx?$` also matches `.ts`). A backend/test/script `.ts` no longer wrongly demands react SOLID refs. New `nearest-manifest.ts` (walk-up to the closest `package.json`/`composer.json`/`Package.swift` + `projectCaps` reading `dependencies`/`devDependencies`, reusing `detectProjectType` for non-JS langs); `detect-framework.ts` becomes `fileSignal` + `reconcile` (`.tsx`/`.jsx`→react/next only if the project is capable, `.ts`/`.js`→framework only when capable AND a content signal is present, else `generic`; non-JS extensions stay definitive; fail-open to `generic`). The twin `.ts`→react bug in `file-size-scope.ts` (`resolveSolidRefFramework`) routes through the same resolver. No new labels, no cache. `handle.ts` interfaces extracted to `handle-types.ts` to stay under 100 lines.

## [0.1.70] - 12-07-2026

### Added

- **`--sound <kind>` CLI short-circuit** (`hook-sound.ts`): the `hook` command now accepts `--sound stop|permission|human` (as `--sound X` or `--sound=X`), plays the embedded sound via `notify(kind)` and exits 0 without reading stdin or entering `handleHook`. This lets a plugin's hooks.json route every notification sound through the harness **exclusively** (single sound source) instead of native `afplay` — Claude already routes by `matcher`, so each hook line passes the sound explicitly (`PermissionRequest`/`permission_prompt`→permission, `idle_prompt`/`elicitation_dialog`→human). Fail-closed on absent/unknown kind (falls through to the normal flow); harness-agnostic (no `id` gate → codex/cursor/hermes call it identically). Creates the previously-missing `notify("permission")` call site. `bin.ts` gains one logic line (97 l., < 100); `dispatchLifecycle`/`notifications.ts`/`notification-sound.ts` untouched. 11 new tests; full suite 672 pass / 0 fail, `tsc --noEmit` clean.

## [0.1.69] - 11-07-2026

### Added

- Codex functional parity — the harness now governs Codex like Claude Code, all new behavior gated `id === "codex"` (claude-code/cursor/hermes byte-identical, proven by the 36 pre-existing sim scenarios replayed unchanged against the dist binary):
  - **apply_patch fan-out** (`post-fanout.ts`): PostToolUse reaches the post-handlers per patched file (add→Write, update→Edit, delete/move no-op); `normalize.ts` stops force-phasing apply_patch to "pre" so PostToolUse events route to handlePost. Non-apply_patch tools keep strict event identity.
  - **Lifecycle**: Stop dispatched per scope (`stop-core.ts`, the Codex path lacking SessionEnd/TaskCompleted); `designLifecycle` extended to codex; SessionStart resync of agent/command TOMLs under codex (`codex-resync/`, O_EXCL `wx` lock, sha256 fingerprint idempotence, fail-open, writes only under `$CODEX_HOME`).
  - **Tracking/security**: Codex PostToolUse failures classified (`codex-post-failure.ts`); shell reads of refs credited (cat/head/tail/sed/rg/less/more/bat incl. `sh -c`, `sed -i` excluded); `securityAdvisory` fans out per patched file and returns `additionalContext` only (never a bare `permissionDecision:"allow"`, which Codex rejects).
- **Notification sounds** — portable, on by default (`FUSE_HARNESS_SOUND=0` to mute), bundled in `assets/song/` (finish/permission-need/need-human), resolved by package walk-up (works from src and flattened dist chunks) with `FUSE_HARNESS_SOUND_STOP/PERMISSION/HUMAN` overrides and a `$CLAUDE_PLUGIN_ROOT/song` fallback; absolute fail-open. Wired only where events reach the harness (Stop=Codex path, TeammateIdle) — Claude keeps its native afplay hooks, no double-sound.

### Changed

- `evaluate.ts` split: the two git gates extracted verbatim into `git-gates.ts` (SRP, evaluate.ts back under 100 lines) — byte-identical prompts. Clears the 0.1.68 line-count debt.

## [0.1.68] - 11-07-2026

### Fixed

- File-size gate remediation deadlock: an Edit on a file already over `FUSE_SOLID_MAX_LINES` was ALWAYS denied (the gate judged `Math.max(new_string, on-disk)` — the on-disk count won every time), so an oversized file could never be shrunk or split via Edit. The gate now computes the REAL post-edit line count (`existing − old_string + new_string`, scaled by occurrences under `replace_all`, fail-closed when `old_string` doesn't match): a shrinking Edit of an oversized file is allowed (monotonic convergence — growth stays impossible), and a computable violation is denied on the real outcome, which also closes the historical grow-via-Edit hole (a compliant 95-line file pushed to 106 by an Edit used to pass unseen). Write and apply_patch behavior unchanged. 8 invariant regression tests + sim scenario 33 on the real binary.

### Known debt (accepted)

- `src/policy/evaluate.ts` temporarily at 103 lines (> 100): the compacted version + SRP git-gates extraction are ready but blocked by the deployed harness's own Edit deadlock — the exact bug this release fixes. Follow-up lands right after the deployed harness syncs to this version.

## [0.1.67] - 11-07-2026

### Added

- Codex multi_agent_v2 custom agents now count as agent evidence: on PostToolUse under Codex, a `spawn_agent` call carrying `tool_input.agent_type` (exposed when `hide_spawn_agent_metadata=false`) is recorded as `subagent-<agent_type>` in the SAME SessionTrack as Claude Task evidence — APEX freshness gates see a Codex explore-codebase/sniper exactly like a Claude subagent. Detection covers both proven tool-name forms (openai/codex@44918ea1): canonical `spawn_agent` and the no-separator `{namespace}spawn_agent` concatenation (`fusengine_agentsspawn_agent`). Triple gate against false credits (codex id + spawn form + non-empty agent_type); claude-code/cursor/cline/gemini paths byte-identical (sim parity scenario 32b, stash-replay proven).

## [0.1.66] - 10-07-2026

### Added

- Plain `git push` joins the auto-approved subset under Codex `approval_policy=never` (NEVER_SAFE = RALPH_SAFE + `git push`, visible `[fuse-harness] Auto-approved …` notice) — pushing is the agent's job in that mode and the approval prompt cannot exist. Codex `bypassPermissions` ONLY: Claude Code and RALPH paths are byte-identical (patterns.ts untouched, parity scenario green). Destructive forms still deny via `isSafePushForm`: `--delete`/`-d`, `--mirror`, `--prune`, refspec deletion (`git push origin :branch`), and the flagless `+refspec` force-push (`git push origin +main` — git-push(1): leading `+` ≡ `--force`), on top of the pre-existing `--force`/`-f`/`--force-with-lease` block. No false positive on `feature+x` tokens or `host:port` URLs; `--force-if-includes` alone is a documented no-op and stays approved; chaining remains fail-closed.

## [0.1.65] - 10-07-2026

### Added

- Codex `approval_policy=never` is now handled instead of dead-ending: the RALPH_SAFE git subset (checkout -b / add / commit / status / diff / log) auto-approves with a VISIBLE `[fuse-harness] Auto-approved …` notice when the hook payload's resolved `permission_mode` is `"bypassPermissions"` (the only value Codex maps from `AskForApproval::Never` — verified at openai/codex@342e4d4b, regression-marker test). Three hard conditions: safe prefix, no destructive match anywhere in the string, single command only (chaining rejected: `&&`, `||`, `;`, `|`, lone background `&` with a bash-redirect exclusion, backticks, `$(`, newlines — quote-unaware fail-closed). RALPH_MODE keeps priority (silent). Claude Code's own bypassPermissions mode is untouched (sim-proven); everything outside the safe subset keeps the existing ask→deny downgrade.

### Security

- `~/.codex/config.toml` and `.codex/rules/` are now write-protected on every harness — an agent can no longer self-grant the never exemption by rewriting Codex's own approval config or authoring an allow rule (Codex's sandbox does not cover user-level `.codex` under danger-full-access).

## [0.1.64] - 10-07-2026

### Fixed

- Linux-only total silence of the hook CLI (all 25 sim scenarios red on CI while green on macOS): a Bun Linux stdin-init ordering bug (oven-sh/bun#25320/#27849) — adding `figures` as the package's first runtime dependency shifted `process.stdin` initialization, and the `for await` stdin loop silently read empty, so every hook ran on an empty payload (stdout "", exit 0, no error). `readStdin` now uses a synchronous fd-0 read (`readFileSync(0)`), shared via `util/runtime-io.ts`. A permanent env-gated stderr tracer (`FUSE_HARNESS_DEBUG=1`, set by the simulator's spawn env) makes any future silent child speak in every scenario failure — CI and local alike. Root cause proven by the tracer's live CI trace (`stdin-text-length: 0` on 25/25).

### Added

- Every deny/ask gate outcome now carries a user-visible `systemMessage` (`✘ <gate title>` / `? <gate title>` via the `figures` package — text-presentation symbols, Windows fallbacks, never emoji) on claude-code/codex, deduped across the ~11 sibling-plugin fan-out (`onceExclusive`, 2s burst window, re-emission after the window proven by test). All THREE deny return points in handle-pre.ts are covered (designGate, applyPatchGate, main gate) — the owner watched agents obey blocks that were invisible in the TUI since 0.1.57 equipped only the allow path. The agent channel (`permissionDecision`/`permissionDecisionReason`) is byte-identical (stdin-proven on all three paths); cursor/hermes/cline pass through untouched (cursor already emits its native `user_message`); notice attachment is fail-open — any FS error still ships the untouched deny decision.

## [0.1.63] - 10-07-2026

### Fixed

- The per-prompt APEX condensate (buildApexInstruction) now lists all 6 phases — eLICIT (named-technique self-review) and VERIFY (functional check) were omitted, so leads followed the injected 4-phase text and skipped both; an explicit gate line ("eLicit + Verify BEFORE sniper — NEVER skip") is appended. The tracking-file line no longer claims `/apex` creates `.claude/apex/task.json` (no code path ever creates it — proven by grep of sync-task/apex-task-store): the agent is instructed to create it via apex-methodology Step 0. The SubagentStart "APEX Sub-Agent Instructions" gain a "Before Done (NEVER skip)" eLicit/Verify section. `dispatchLifecycle` routes scope `rules` on SubagentStart (mirroring SessionStart; previously fell through to the MCP cache default — inert in prod until claude-rules registers that hook). Fresh-build behavioral diff across all 34 event×scope pairs: only the two intended outputs changed. Companion audit claim "PreToolUse gates don't fire inside Task-tool subagents" investigated and REFUTED (docs agent_id/agent_type, maintainer test closing anthropics/claude-code#21460, live repro) — no disk-artifact migration needed.

## [0.1.62] - 09-07-2026

### Fixed

- Destructive git flag patterns no longer match as bare substrings of arguments: `-f`/`--force`/`--force-with-lease`, `--hard`, `-D` and the `git clean` f+d short-cluster now anchor on token boundaries (leading space, trailing space/`=`/end), so a branch named `fix/guard-false-positives` pushes normally (3rd live repro closed) while `-fd`, `-df`, `-fdx`, `-xfd` clusters stay denied. Sim scenario 27 locks both directions.
- `solidReadGate` now credits a SOLID ref read performed through a DIFFERENT root than the marketplace-first path it expects: new `refs/ref-key.ts` normalizes recognized skill paths (config-dir-anchored marketplace/version-cache trees, standalone `.claude|.codex|.cursor|.agents/skills`, `/etc/codex/skills`) to their `skills/<skill>/…` suffix before comparison. Closes the "sub-agent/teammate reads the versioned cache path (`fuse-solid/1.0.12/skills/…`), gate expects the marketplace path (`plugins/solid/skills/…`), never credited" gap. Exact-match check stays first (lead behavior byte-identical, strictly additive); forged paths outside recognized roots never credit by suffix (sniper-tightened anchoring + regression tests). +10 tests (545 pass), sim 31/31.

## [0.1.61] - 07-07-2026

### Fixed

- Closed a total fail-open on Codex: `tool_input.command` arrives as an ARRAY (`["bash","-lc","…"]`) on Codex, and `normalize.ts` silently dropped non-string commands (`str()` → undefined), so every command gate (git blocked/ask, mutators, RALPH exemptions) allowed anything. New `runtime/command-string.ts` normalizer (string passthrough; `[shell, -c|-lc, script]` → script; other string arrays → joined) wired into `normalizeEvent` and the codex/claude/hermes adapters. Array and string payloads now produce byte-identical verdicts (proven by replay); string behavior is a strict no-op (full suite unchanged: 535 pass). New sim scenario 26 (codex array-form deny) + unit/pipeline tests.

## [0.1.60] - 06-07-2026

### Fixed

- Closed the env/wrapper-prefix mutator bypass (previously a documented "accepted gap"): code mutators (sed/perl/awk in-place, patch, tee/dd into code files) are detected BEFORE the SAFE_PREFIXES short-circuit, so `env sed -i src/foo.ts`, `timeout 5 patch`, `cp a b; tee src/x.ts` now deny. Every pattern is command-position anchored via a shared CMD anchor (`bash-command-anchor.ts`) — a quoted MENTION (`git commit -m "fix sed -i doc"`, `--grep "sed -i"`) still passes, locked by explicit negative tests. Sim scenarios 24 (claude-code) + 25 (codex); the 27 pre-existing scenarios stay green in both modes. Documented residual: bare `--` end-of-options wrapper form (owner-accepted follow-up).

## [0.1.59] - 06-07-2026

### Fixed

- SubagentStop no longer demands sniper validation on files the agent deleted before stopping (scratch probes, temp dirs): the owned list is filtered against the disk (`existsSync(resolve(hookCwd, f))`) before the reminder; all gone → the "no code changes" path. TeammateIdle audited and confirmed not affected (already stats the disk). Found by the 0.1.58 live test.
- notices.ts documents the channel contract: `userMessage`/`systemMessage` is human-only (excluded from formatPrompt, never reaches the agent) and emitted exactly once under the multi-plugin fan-out via onceExclusive — verified live 2026-07-06. Settles the "invisible notice" report as by-design (no code change; an agent-debate judge's differential probe overturned the initial fix verdict).
- Tests: stale-file scenarios moved to a dedicated `agent-memory-stop.test.ts` with real on-disk fixtures plus two new cases (deleted-before-stop → silent; mixed present+deleted → only survivors listed); parity-freshness/receipts now create their fixture files on disk.

## [0.1.58] - 06-07-2026

### Added

- Codex `apply_patch` is now gated (it was 0% — enforcement theatre on Codex's PRIMARY edit primitive): the patch text is parsed per file (`adapters/codex/apply-patch.ts`), each hunk runs the file gates (protected-path, file-size, DRY) and ONE violating hunk denies the whole patch (`runtime/apply-patch-gate.ts`) — a compliant file can no longer smuggle an oversized one through. Codex `ask` prompts downgrade to an explicit deny (it fails open on unsupported shapes). Sim scenarios 22-23.
- Multi-harness simulator: scenarios carry an optional `harness` field (validated against the real id list, defaults to `claude-code`) replayed via `hook <harness>`; new scenarios 19-23 exercise codex/cursor/hermes end-to-end, so the shared-guards invariant is mechanically CI-locked. Hermes live-test protocol documented (`docs/hermes-live-test.md`).
- Global injection budget recap (one user-visible line per SessionStart/SubagentStart tallying all injected fragments) and a strictly-once sniper reminder (exclusive-create dedup + bounded purge, replaces the residual 2-3× fan-out duplicate).

### Fixed

- Teammate ref-read gap: the on-disk transcript flushes ~230s late (beyond the freshness TTL), so a teammate's just-read SOLID ref was invisible to the transcript reconcile while its live track write was lost to the fan-out race — teammates had to delegate their writes. `gate()` now also reconciles refs from an append-only journal (`ref-journal.ts`, `O_APPEND` — race-immune AND fresh), trimmed to a 128KB bound on the shared state dir.
- Cursor `afterFileEdit` is now advisory-only: it returns `allow` + a `user_message` correction on a violation instead of a `deny` that has no proven upstream effect (the hook launched "informational only"; Cursor's deny-enforcement for file operations is confirmed broken upstream, forum.cursor.com/t/154377). `deny` stays reserved to the proven `beforeShellExecution` path.
- bash-write false positive: `patch` matched as a bare word (blocking read-only commands merely naming a path, e.g. `jq . apply-patch.json`); now matched only as a command token.
- Docs: README + adapters compatibility matrix updated to the real per-harness ceilings with upstream sources (Codex #27833, Cursor forum #154377).

## [0.1.57] - 06-07-2026

### Added

- Failure-time lessons (`PostToolUseFailure`, Claude-Code-only): a failing tool call is matched against the lesson `[TRIGGERS error:]` regexes and THE matching lesson is injected at the moment of the error; failures land in the one-shot sidecar (additive `failures` field). Sim scenario 17.
- Teammate-idle deliverable check (`TeammateIdle`, Claude-Code-only): on a teammate's idle, its announced deliverables (harvested `modifiedFiles`) are stat'ed on disk — a missing one warns the lead "verify before treating as done". The idle≠done discipline, mechanized.
- Post-compact reinjection (`PostCompact`, core scope): reconciliation snapshot + "context was compacted — reread files before editing" reminder, burst-deduped. Sim scenario 18.
- Injection budget: every harness-produced fragment (lessons, snapshot, apex-task, dev-context, apex-subagent) is hard-capped at 8000 chars with a located truncation notice; the owner's CLAUDE.md context is exempt by test-locked invariant.
- Compliance notices (user-visible `systemMessage`): `✓ SOLID refs read`, `✓ evidence fresh — explore+research`, `⚠ sniper required: <file>` — burst-deduped per session, no-op on harnesses without the channel.
- Honest documentation: README + adapters/policy/runtime/config/index rewritten — compatibility matrix with per-harness limits (file:line cited), dual state roots documented, every feature claim backed by a cited test or sim scenario; ROADMAP swept against reality (6 stale items closed with proof).

### Fixed

- Codex adapter comments now state the real coverage (`apply_patch` edits gated at 0% — parser on the roadmap) and guard against wiring Codex `PermissionRequest` until `respond()` emits its wire shape; Claude-Code-only docstrings on non-portable features.
- Simulator: explicit 30s per-scenario test timeout (kills the bun 5s-default flake vector under load; the 2s burst window itself has ×23 measured margin).

## [0.1.56] - 06-07-2026

### Fixed

- Lead `refsRead` credit (root-caused with live data): `saveTrack` does an unlocked load→mutate→write, so under the ~11-process hook fan-out a ref read recorded ONCE was lost with ~100% probability while agents/doc evidence self-healed on later writes — the lead could read every listed SOLID ref and never satisfy `solidReadGate` (subagents were unaffected: SubagentStop already harvests their transcript). `gate()` now reconciles `.md` Reads from the session transcript (append-only, race-immune) into `refsRead` before any consumer — never downgrades a newer stamp, fail-open, TTL semantics unchanged. Regression test proves lost-write → BLOCK → reconcile → PASS, and stale reads stay blocked.
- Lesson compression: the rule separator is a SPACED arrow only — a glued arrow (`120s→300s`) is prose; short trailing asides are dropped without losing in-prose arrows. Fixes the last 2/40 mid-token compressed bullets found by the live test.
- Residual 2× sniper reminder documented as an accepted tradeoff (a per-key exclusive-create dedup would need its own purge sweep — separate batch if ever needed).

## [0.1.55] - 05-07-2026

### Fixed

- Per-event dedup of counters and reminders (found by a live subagent test on deployed v0.1.54): ~11 deployed plugins each invoke the binary on the SAME tool event, so the deny-loop counter jumped +11 per real attempt ("Identical attempt #9" on an agent's FIRST try), the one-shot metric was inflated 11x and the sniper reminder was injected ~15x per edit. Counters are now keyed `(op-hash + session_id)` over a 2s burst window (`burst-window.ts`); sibling fan-out processes get the prior verdict VERBATIM (one consistent count) and different sessions never dedup each other; the reminder is emitted once per (file + session + window) via the shared `oncePerWindow` sidecar.
- Readable lesson compression: the distilled one-line rule is now the longest segment after an arrow with a 40-char minimum (fallback: the full rule's first sentence) — no more truncated fragments.

### Added

- Simulator: per-step `delayMs` (validated at load, 4s bound — `bun test` kills a test at 5s) so scenarios can distinguish a genuine agent retry from a hook fan-out burst; scenario 03 rewritten (a spaced retry escalates to `#2`), scenario 16 proves the burst collapse end-to-end in src and dist CI modes; `load.ts` split (SRP) into `load.ts` + `validate.ts`.

## [0.1.54] - 05-07-2026

### Added

- Two-stage LESSON.md compactor: beyond the 50-bullet cap the oldest bullets are MOVED (never deleted) to `MEMORY/LESSON-archive.md` (archive-first, atomic, fail-safe); `[TRIGGERS]` bullets stay until >90d so the decision-time index keeps working. The SessionStart/SubagentStart injection is compressed mechanically — the 10 most recent bullets go in full, every older one is reduced to its dated actionable rule — a measured **73.5% token reduction** (103.6kB → 27.5kB) on a real 121-bullet file, while the file itself keeps full bullets. Project isolation (each session receives only its own project's LESSON.md) is now test-locked; sim scenario 15 covers the compressed injection in src and dist CI modes.

### Fixed

- English-only emitted strings: the deny-loop `[REPEAT]` message, curation/merge/archive reports, MCP cache-hit text and the subagent cache injection block had shipped in French (leaked from French-language teammate briefs and the original Python port). All harness-emitted strings are now English; French-detection regexes (prompt classification, lesson tokenization) are intentionally kept.

## [0.1.53] - 05-07-2026

### Added

- Reconciliation snapshot at core SessionStart: git state (branch, recent commits, WIP counters), running harness version with drift warning, persistent `.claude/BOARD.md` rehydration and the one-shot gate summary — offline-only collectors, each isolated fail-safe, concatenated onto the existing injected context (the CLAUDE.md invariant is never violated, even on unparseable stdout).
- One-shot gate metric: every gate outcome lands in a 7-day pruned sidecar (`one-shot.json`, deny-loop-store pattern); a deny and its later fix link through a content-free op key so the deny→allow transition is visible; `oneShotSummary(cwd)` derives the state dir with the exact `defaultStateDir(cwd)` the writer uses (single shared path deriver — a wired-but-dead seam caught during the batch).
- Simulator: optional per-scenario `setup` files (validated, `$TMP`-contained) so E2E scenarios can materialize project roots; scenarios 13 (multi-session Stop scoping — fails on the pre-fix code) and 14 (snapshot) run in both src and dist CI modes.

### Fixed

- Lessons Stop reminder cross-session leak (production bug): with 2-3 concurrent sessions the reminder listed ANOTHER session's project and consumed its throttle, sending lessons to the wrong LESSON.md. Reminders are now keyed per `(session_id, root)` in a pruned home-cache registry; the legacy path (no session id, old state format) is preserved and test-covered.

## [0.1.52] - 05-07-2026

### Added

- Hook simulator (`test/sim/`): a 12-scenario corpus of full hook-event sequences (payload on stdin → expected verdict on stdout) replayed against the REAL binary — `bun src/cli/bin.ts` locally and `node dist/cli/bin.mjs` (`SIM_BIN`) in CI after a build. Each scenario runs in a fresh `$TMP` (HOME=cwd) with a scrubbed env, shared across its steps so on-disk session state persists: block → comply → pass, deny-loop `[REPEAT]`, TaskCompleted receipt refusal, SubagentStop evidence harvest, session isolation, git ask/deny, SKILL.md tolerance and solid-scope routing are all exercised end-to-end. Kills the "ported but never wired" and "works from src, broken in dist" classes — the dist mode caught a real relative-path spawn bug before this ever merged.
- CI: `Build` + `SIM_BIN=dist/cli/bin.mjs bun test test/sim/` steps; `bun run sim` script. Guards: a present-but-empty scenario dir fails red (no silent green), malformed stdout matchers are rejected at load with a located error.

## [0.1.51] - 03-07-2026

### Added

- Verification receipts: `tsc`/`bun test` runs are captured as receipts in the signed SessionTrack (PostToolUse Bash parse); TaskCompleted now REFUSES a "done" (`{"continue":false,"stopReason"}` — the only documented refusal shape for this event) when code files changed without a fresh passing receipt; SubagentStop appends an advisory "NO VERIFICATION RECEIPT" note to the attributed reminder. Kills the declared-done-but-broken pattern (3 live occurrences this week).
- Deny-loop breaker: every gate deny is hashed (stable, key-order-free) into a state sidecar; an identical retried call gets a rewritten "[REPEAT] … STOP" message with a mandated research-expert action — the decision itself is never changed, allows are never touched, hashes expire with the freshness window.
- SubagentStop evidence harvest: the finishing sub-agent's own transcript (`agent_transcript_path`) is parsed and its research/explore calls + `.md` ref reads are backfilled into the session track BEFORE the reminder — the freshness gate now sees sidechain evidence even when sidechain PostToolUse hooks never fire (platform issues #43612/#27655/#34692). Transcript parser factored into `agent-transcript.ts`, shared with the v0.1.50 attribution.

## [0.1.50] - 03-07-2026

### Added

- Decision-time lessons: a `MEMORY/LESSON.md` bullet may end with a `[TRIGGERS tool:… path:… error:… keyword:…]` line; the single most-specific matching lesson is injected as `additionalContext` at the exact PreToolUse about to repeat a known mistake — allow-path only (never masks a deny/ask), cooldown-guarded (30min via the shared `oncePerWindow`), backward compatible (untagged bullets keep the SessionStart block).
- Lesson curation on read: strict near-duplicate merge (the removed twin's `[TRIGGERS]` line is carried over), >50-bullet cap and >90-day stale paths reported to the user via `systemMessage`; `LESSON.md` is rewritten only on real merges.
- Context-injection dedup guard: `oncePerWindow` (state-backed sidecar) suppresses only a same-turn double-fire of an identical CLAUDE.md block; the invariant "CLAUDE.md injected on EVERY message" is CI-guarded (`claudeMdKey` shared between prod and tests).

### Fixed

- SubagentStop attribution: the sniper reminder now lists only the files the stopping agent actually wrote (parsed from its own `agent_transcript_path`, null-safe fallback to the session-wide list) and the cumulative counter survives non-authors — reproduced 3× live, including a research-only agent ordered to validate 14 foreign files.
- SOLID: `handle-pre` allow-path extracted to `pre-allow.ts` (87/40 lines).

## [0.1.49] - 02-07-2026

### Added

- Per-framework skill authorization (Check 1, parity `enforce-apex-phases.ts`): `doc_consulted` stamped per framework and re-validated against `FUSE_ENFORCE_TTL_SEC` on every edit; a deny writes a persistent `target` cross-credited on EVERY later consultation (parity `track-doc-consultation.py` — no TTL, no single-shot clear, kills the deny→consult→re-deny loop). Trivial-edit budget (5th small Edit in the window requires full APEX; `replace_all` never trivial). `PROTECTED_PATHS` denied early in `gate()` on ALL extensions with the byte-for-byte Python message.
- Session-scoped agent evidence (parity `track-subagent-research.py`): research/explore tool calls are persisted into the signed `SessionTrack` keyed by `session_id` — sub-agent and workflow-agent research now satisfies the freshness gate; the lead-transcript scan is demoted to fallback.
- Doc consultations credited to the framework named in the QUERY (`track_doc_helpers.detect_framework` keyword map, 9 verbatim regexes) instead of always `generic`.
- `Prompt.userMessage` channel (parity `hook_output.allow_pass`/`post_pass`): user-visible pass notices per harness — claude/codex `systemMessage`, gemini `systemMessage`, cursor `user_message` (snake_case, camelCase silently ignored — cursor forum #141516/#142589), cline/hermes documented drop. Design-pipeline and solid-detect notices restored.
- Hermes adapter: `~/.hermes` home, `HERMES_SESSION_ID` detection, `{decision:"block",reason}`/`{context}` protocol (Claude-style output accepted natively by Hermes), wired in `respond()` + build exports.
- `fuse-browser` network tools added to `RESEARCH_TOOLS` — the deny message already promised them as an accepted fallback but the freshness table never credited them.
- Check-1 deny sources resolved dynamically (`skill-source.ts`, 10-entry map + context7 fallback): a deny never promises a nonexistent SKILL.md path.

## [0.1.48] - 02-07-2026

### Fixed

- SOLID-read TTL was inert: `refsRead` had no timestamps, so a single skill read satisfied `solidReadGate` for the whole session while its message claimed "(expires every 2min)". Every `.md` read is now stamped (`refsReadAt`) and re-validated against `FUSE_ENFORCE_TTL_SEC` (120s) on every edit — parity `require-solid-read.py`/`track-solid-reads.py`. TTL confined to `solidReadGate` (Python TTL-izes SOLID reads exclusively); pre-TTL tracks stay valid (unstamped paths count).
- `handle-pre`: the `solid` scope now always returns after `validateSolidGate` (mirror of `security`) — no more double `gate()` run per edit when core-guards and solid both wire PreToolUse, and no more over-policing Bash (the Python solid plugin never gated Bash).
- `explore-tools`: reading a real TS cache file (`<root>/.harness/cache` or `~/.fuse-harness/cache`) now credits research-expert; only the legacy Python cache names (`context7-…`) were recognized.
- Tests: +7 (6 `parity-b4-*` files + a wiring guard asserting `recordActivity` forwards `ts` into `refsReadAt` — the one-word link the whole TTL hangs on, missed by the integrator and caught by the adversarial review).

## [0.1.47] - 2026-07-01

### Added

- Tailwind base-skill gate (ports `check-tailwind-skill.py` Phase 1): a `.tsx/.jsx` write with Tailwind utility classes now requires a `tailwindcss-v4`/`tailwindcss-utilities` skill read this session.
- Opt-in Gemini Design MCP gate (`FUSE_ENFORCE_GEMINI_MCP`, default off): blocks hand-written Tailwind UI until a `mcp__gemini-design__*` call is made.
- Ralph mode (`RALPH_MODE`, env-only, default off): exempts safe git commands from the confirmation ask and auto-approves project installs; destructive git and system installs still gate. The Python source's silent `feature/*`-branch / `prd.json` auto-activation is intentionally dropped.

### Fixed

- `detect-framework`: complete the Next.js signal set (`NextRequest`/`NextResponse`/`getServerSideProps`/`middleware`) so Next.js files stop mis-classifying as react.
- `framework-solid-exclude`: anchor the JS build-dir exclude on path segments so `distance.ts` / `rebuild/` are no longer skipped from SOLID checks.
- `framework-skill-gate`: skip the sub-skill gate on build/vendor artifacts (parity with the Python `check-*-skill.py` early return).
- `security`: accumulate every matched violation (deny when any is critical) and exempt a `trash`-targeted `rm` from the ask.
- APEX gates: exempt subagents from the brainstorm requirement; exempt `.claude/fusengine-cache/` paths; widen the dev-verb trigger to the full `DEV_KEYWORDS`.
- `modular`/`skill-triggers`/`design`: precise FuseCore target sub-path, dedicated FuseCore skill message, dedicated `design-system.md` not-found message.

### Removed

- Dead `src/state/*` (duplicate of `apex-task-store`) and dead `preScreenshotWriteGate` (its `check-browser-browsing.py` source is not wired in any hooks.json; the screenshot quota lives in `designSystemWriteGate`).

## [0.1.46] - 2026-07-01

### Fixed

- `solidReadGate` required the exact `references/*.md` path to be read, unlike the 3 other `refsRead`-consuming gates (`skillTriggerGate`, `shadcnBaseSkillRead`, `designSkillRead`), which already accept reading the skill's parent `SKILL.md` as proof of consultation. Reading only the `SKILL.md` — the natural reflex, and what the gate's own message suggests — satisfied 3 of 4 gates but never this one. Now accepts either.

## [0.1.45] - 2026-07-01

### Fixed

- Design pipeline gates (`stateFileGate`, `htmlCssOnlyGate`, `browserNavigateGate`, `designSystemWriteGate`, `geminiCreateGate`): restored the anti-loop warning + phase sequence, the domain-expert handoff phrase, the 2 distinct SKILL.md paths (phase 0 vs phase 1) + explicit 9-domain inspiration catalog, and numbered RECOVERY steps with explicit MCP tool names — all lost in the initial port (`gates.ts` split into `gates-pipeline.ts` to stay under the SOLID file-size limit).
- MCP/WebFetch cache-hit interception served the raw cached body with no wrapper; restored the `CACHE HIT (~NKB economise, cached il y a Hh): {body}` notice (WebFetch variant differs slightly), parity `webfetch-cache-lookup.py`/`mcp-cache-lookup.py`.
- `shadcn-skill-gate.ts` lost the `mcp__shadcn__search_items_in_registries` unblock option (text AND logic) — restored, with a real live tracking path (`activity.ts`'s `docSourceOf` now recognizes `mcp__shadcn__*` calls as a new `"shadcn-mcp"` doc source, wired end-to-end through the existing `authorizations` pipeline).
- `skill-triggers.ts`'s missing sub-skill message pointed at a relative `skills/<name>/` fragment instead of the real, absolute `SKILL.md` path — restored via a NEW dynamic resolver (`skill-path.ts::resolveSkillPath`) that scans installed marketplace plugins for the skill on disk, rather than a hardcoded framework->plugin-dir table (which would have mis-resolved cross-plugin skills like `react-shadcn`, actually installed under `shadcn-expert`).
- `modular.ts`'s Next.js/FuseCore modular-architecture messages lost 3 fragments: the explicit `app/` convention file list, the "Cores must be independent" rationale, and the word "from" in the cross-module-import message.
- `dry.ts`'s duplicate-file list silently dropped files beyond the first 3 with no indication more existed — now shows `(+N more)` when applicable, parity `detect_duplication.py`.

## [0.1.44] - 2026-07-01

### Added

- `harness scan [dir]`: OWASP security scanner (18 patterns JS/PHP/Python/Swift), ports `security-scan.py`.
- shadcn/ui skill gate: 5 sub-skills (`shadcn-detection/components/theming/registries/migration`) + standalone gate for `components|ui|shadcn|components.json`-scoped writes, independent of the detected framework — ports `shadcn-expert`'s `check-skill-loaded.py` (previously entirely unported).
- `detectPrimitiveLib()`: weighted Radix UI vs Base UI detection (package.json/components.json/imports/data-attrs), ports `detect-primitive-lib.py`.
- `checkFileSize()`: adaptive SOLID file-size warning keyed off the detected project type (`SOLID_FILE_LIMIT`), ports `solid/check-file-size.py` — the limit was computed but never read.
- `checkSolidCompliance()` / `checkSolidFromTranscript()`: ai-pilot PostToolUse/SubagentStop SOLID + interface-location checks, ports `check-solid-compliance.py` / `check-solid-from-transcript.py`.
- `autoDocumentRead()`: auto-generates `.claude/apex/docs/task-<n>-<framework>.md` on a SKILL.md/README/docs Read, ports `auto-document-reads.py`.
- `doc-cache-gate`: PreToolUse deny for a redundant Context7/Exa query when the doc is already cached fresh (<7d).
- `SAFE_PREFIXES` + a harness-owned-path allowlist (`~/.fuse-harness/cache`, `~/.claude/logs`) in the bash-write guard, ports `bash-write-guard.py`'s fast-path + `safe_paths.py`.
- Tailwind utility-class detection on `.tsx`/`.jsx` (in addition to the react/nextjs framework gate, not instead of it) — the previous port only matched `.css`, the inverse of the real use case.
- `countFrameworkCodeLines()`: comment/blank-excluding line counter for the react/nextjs/laravel/swift SOLID gates, ports `validate_solid_common.py::count_code_lines`.
- `validate-solid.ts`: Go interface-location and Python ABC checks (PostToolUse, scope `solid`), ports `validate-solid.py`'s `check_go`/`check_python` (`check_nextjs`/`check_laravel`/`check_swift` deliberately not ported — already covered by `framework-solid-gates.ts`).
- `validate-tailwind.ts`: deprecated `@tailwind` directive / excessive `@apply` / overlong `className` warnings (PostToolUse, new scope `tailwindcss`), ports `validate-tailwind.py`.
- `hasTailwindDependency()`: `tailwindcss` package.json dependency fallback for Tailwind v4 CSS-first projects with no config file, ports `is_tailwind_project`.
- `test/parity-freshness.test.ts`/`test/bash-write.test.ts`: non-regression tests for the `agentsRanFromTranscript` direct-tool-use branch and the `bash-write-safe-paths.ts` hardening.

### Fixed

- **Doc-consultation gate regression**: `isDocConsulted` required only ONE of context7/exa/web (OR); the Python source (`mcp_research_done`) requires BOTH context7 AND exa. Restored to `(context7 AND exa) OR a web fallback alone` — found independently by 3 separate audit teams. The web-alone fallback (WebSearch/WebFetch/fuse-browser) is a deliberate TS addition, not a Python behavior.
- Design-agent lifecycle: `SubagentStop` was gated by the same `agentType.includes("design")` filter as `SubagentStart`, so a Stop event with a missing/different `agent_type` never cleared the `design-agent-active` flag — a stale flag then routed every subsequent top-level Write/Edit through the design-only `htmlCssOnlyGate`. Fixed by clearing the flag purely on `agent_id` match, and by never falling back to the stale flag for a call with no `agent_id`.
- `brainstormGate` no longer requires brainstorming before an `Edit` (parity `require-apex-agents.py`: only `Write` creates new files).
- `bin.ts` no longer imports a non-existent module (a batch-apply ordering issue during this session, caught before it reached a released version).
- SOLID line-counting divergence: the react/nextjs/laravel/swift gates counted raw physical lines instead of excluding blank/comment lines like the Python source — could block a comment-heavy file under the 100-line limit that the source would have allowed. The generic core-guards ceiling (`evaluate.ts`, parity `enforce-file-size.py`) intentionally keeps the raw count — it is a different Python rule.
- `bash-write-safe-paths.ts`: 3 hardenings — `isSafeWritePath`/`isSafeCommandTarget` now require a segment boundary (`target === safe || target.startsWith(safe + "/")`, was an unanchored `startsWith` a sibling directory like `~/.claude/logs2-x/` could match); `resolvePath` now only expands `~` alone or a `~/` prefix per POSIX tilde-prefix semantics (was over-expanding `~user`/`~2xyz`/`~+`); `hasSafeWriteTarget` now requires the safe path to appear as a quoted string literal or quoted sub-path (was an unanchored substring match a `node -e` call could satisfy via an inert comment).
- `agentsRanFromTranscript`: now also credits a direct exploration/research `tool_use` (Glob/Grep, an explore Bash command, mcp__context7/mcp__exa, WebSearch/WebFetch) issued by any sub-agent within the same transcript, not just a nested `Task`/`Agent` invocation — parity `track-subagent-research.py`, which classifies any sub-agent's direct tool call into shared session state unfiltered by author. Reuses the existing `classifyExplore` classifier (previously only wired into the self-recorded track fallback).
- Trivial-edit fast path (skips the APEX gates for a few tiny edits) no longer applies to `Write` — parity `enforce-apex-phases.ts`, which reserves it for `Edit` only (a `Write` always creates/replaces a file wholesale).
- `doc-cache-gate.ts`'s Context7 branch required a non-existent `topic` input field (the real `mcp__context7__query-docs` schema is `{libraryId, query}` — confirmed against the primary upstash/context7 source and this harness's own `cache-doc.ts`/`mcp-key.ts`, both of which already key on `query`), making the redundant-doc-call gate a no-op for every real call. Fixed to check `query`.
- `dryGate`: a single pre-existing duplicate symbol now returns a non-blocking `inform` (parity `detect_duplication.py`'s `allow_pass` for exactly 1 match) instead of being silently swallowed like 0 matches — only 2+ still `block`.
- `effectiveLines` (framework SOLID size check on an `Edit`): the on-disk full-file line-count max was applied uniformly to react/nextjs/laravel/swift; only `validate-nextjs-solid.py` imports `get_full_file_content` in the Python source, so react/laravel/swift now judge the edited snippet alone, matching their real (less strict) Python behavior.
- `freshnessGate`'s deny message lost the Python `AGENT_TTL_LABEL` (e.g. "2min TTL") during the initial port — restored via the existing `ttlLabel`/`DEFAULT_TTL_SEC` helpers, no new formatting logic.
- `DOC_CACHE_TTL_SECONDS` (doc cache freshness, 7d): `inject-doc.ts` and `doc-cache-gate.ts` each defined their own local `TTL_SECONDS` for the same cache — extracted into a single export in `cache-base.ts`, imported by both, to remove the silent-drift risk that caused the `DEFAULT_TTL_SEC`/`DEFAULT_WINDOW_MS` regression above.
- `solidReadGate`'s deny message lost the Python `formatRoutedDeny`'s TTL label, optional refs, and "Full skill:" pointer during the initial port — all 3 restored. Note: `routed.skillPath` is currently always empty in production (`solidReadGate` never threads a resolved skill dir through `ApexContext`) — tracked as a follow-up, not fixed here.
- `evaluateFileSize`'s deny message was reduced to "File has N lines (max: M)." — the Python `enforce-file-size.py` includes the filename, a framework-resolved SOLID reference path, and a 3-step split plan. Restored via new optional `filePath`/`framework` params (backward-compatible defaults).
- `respond.ts`: an `inform` prompt (e.g. `dryGate`'s single-duplicate note) collapsed into a blocking interactive `ask`/`permission:"ask"` in the real production hook pipeline (`gate()` → `handle-pre.ts` → `respond()`), because `respond()` only distinguished `block` from everything else — a prior sniper pass had validated the 3-kind behavior against `toClaudeResponse` (used only by the separate `guard()`/CLI path), not the function actually on the hook path. `respond()` now honors all 3 `PromptKind`s for every harness.
- `security.ts`: deny/ask messages listed 4-7 possible causes in parentheses instead of naming which one actually matched — each `CRITICAL_PATTERNS`/`ASK_PATTERNS` entry now carries its own label (parity `security_rules.py`'s cumulated violation names).
- `interface-separation.ts`: the destination text for TS/JS/Vue/Svelte, PHP and Swift now matches the current `claude-rules/rules/04-solid-dry-rules.md` ("SOLID Skill per Stack" table) — `modules/[feature]/src/interfaces/`, `app/Contracts/`, `Sources/Interfaces/` — instead of the older `enforce-interfaces.py` wording; Go/Python/Java/Kotlin aren't covered by that table and keep a reasonable default.
- `bash-write.ts`: the 7 in-place-edit patterns and 2 ask-writer patterns were collapsed into 2 shared generic messages, never naming which motif (heredoc/sed/perl/awk/patch/tee/dd) matched — each now carries its own `desc`, split into `bash-write-patterns.ts` to stay under the SOLID file-size limit.
- SOLID file-size framework resolution (`evaluate.ts`) used the same `detectFramework()` as the unrelated `require-solid-read` gate (filename/content heuristics), diverging from `enforce-file-size.py::get_solid_ref()` (a same-directory `next.config.*` check) — misresolved nested Next.js App Router files and `.vue`/`.svelte` files. New `resolveSolidRefFramework()` matches the Python algorithm exactly.
- SOLID file-size scope (`evaluate.ts`) included `.css` via the broader `isCodeFile()`, contradicting the same decision already applied to `isApexScoped`; new `isFileSizeScoped()` excludes it, matching `enforce-file-size.py`'s `CODE_EXT`.
- SOLID file-size deny message on a `Write` showed the *incoming* (new) line count instead of the pre-existing on-disk count when both are over the limit — `enforce-file-size.py` always displays the pre-edit count.
- `solidReadGate` silently allowed when SOLID references were loaded but none scored for the edited file; `require-solid-read.py` still denies in that case, pointing at the framework's `SKILL.md`. Now blocks (the "no refs installed at all" case correctly stays allow, per `discoverRefs()`'s documented contract).
- `freshnessGate` always named both `explore-codebase` and `research-expert` as missing, even when only one actually was; now names the precise missing agent(s) via a new `ApexContext.missingAgents` field.
- `claude-md-context.ts::buildApexInstruction` templated the 3rd ANALYZE agent as `${projectType}-expert` (e.g. `generic-expert`, `laravel-expert` — neither is a real installed agent id). Replaced with `expert-agents.ts::getExpertAgent()`, which resolves the real `<plugin>:<agent>` id by scanning installed marketplace plugins (falls back to `general-purpose` when none match) — never a hardcoded table that can drift from what's actually installed.
- `lifecycle-bridge.ts::postEditContext`: `trackSessionChanges || postEditTypescript` always short-circuited on the first (unconditionally truthy for any `.ts`/`.tsx` edit), making the eslint/prettier check unreachable dead code; both now run and their `additionalContext` is merged.

### Changed

- Design pipeline (`SubagentStart`/`SubagentStop`/`agent_id`-gated `designLifecycle`) is now explicitly scoped to `detectHarness().id === "claude-code"` rather than relying on those fields being merely absent on other harnesses.

## [0.1.43] - 2026-07-01

### Fixed

- `harness doctor`/`--version` stderr version banner was printed on every CLI invocation, including `harness hook <scope>` — up to 9 separate hook processes per Edit/Write spammed the transcript. Now emitted only on explicit `--version`/`-v`/`doctor` commands.

## [0.1.42] - 2026-07-01

### Added

- `harness doctor`/`harness --version` command + stderr version banner + post-publish CI check to catch stale `bunx` installs (bug oven-sh/bun#5791).
- Differential Python↔TS test harness plus a golden-snapshot regression suite under `test/parity` (`FUSE_PARITY_PYTHON_ROOT` override).
- `FUSE_MCP_TTL_SEC`/`FUSE_WEBFETCH_TTL_SEC` env vars for the MCP/WebFetch cache TTLs.

### Changed

- Migrated ad-hoc `fs` writes to `atomicWrite`; moved the fuse-harness cache to a neutral `~/.fuse-harness/cache` (was nested under `~/.claude`).
- Extracted cross-module types into `interfaces/` (ISP) and split `handle.ts`/`gate.ts` under the 90-line SOLID limit.

## [0.1.41] - 2026-06-30

### Added

- Doc gate: `WebSearch`/`WebFetch`/fuse-browser now satisfy the doc-consulted gate; `activityFor` returns `Activity[]` so doc tools also credit `research-expert` (parity with the Python two-hook model).
- Auto-discovery of `solid-*/references` across Claude/Codex/Cursor (Open-Agent-Skills layout), deduped by skill name — the SOLID-read gate self-activates with no `FUSE_HARNESS_REFS`.
- `FUSE_HARNESS_MARKETPLACES` allowlist (default `fusengine-plugins`; an absent marketplace contributes nothing).

## [0.1.40] - 2026-06-30

### Fixed — parity with the Python `core-guards` plugin (phase 1)

- Security: `sudo`/`su`/`doas`/`passwd`/`del` now DENY (were ASK).
- `bash-write`: close `sed -E -i`, `node`/`ruby -e`, `dd of=` bypasses; exclude `2>`/`>&2`/`/dev/null`; add `.astro`/`.css`.
- File size counts physical lines (parity `sum(1 for _ in f)`).
- Doc gate: any ONE source satisfies (Context7 OR Exa OR WebSearch/WebFetch) — was AND.
- Credit direct exploration (Glob/Grep/Bash/MCP) + accept `Agent`/`Task` with plugin-prefix strip.
- APEX gates scoped to code files with exemptions; interface-separation PHP/dirs; refs flat scoring;
  protected-path targets the real write destination; MCP/WebFetch cache substring lookup + prompt-keyed
  WebFetch + 24h TTL + compaction/dedup/index; `TaskCompleted` SOLID hook; pre-commit lint runs before the
  git-ask short-circuit; creation-intent skip terms; revived sniper-reminder state readers.

### Fixed — parity with the other ported plugins (phase 2)

- SEO PostToolUse blocks via `decision: block` (was the ignored `permissionDecision` — a silent no-op).
- Sub-agents (explore/research/sniper) receive APEX + project-lessons injection again.
- Global lessons promotion (`_global/<stack>.json`) restored.
- Cartographer plugin-dir resolution is harness-agnostic + handles array-form `hooks.json`.

### Added

- Design UI-write gate (design skill + doc research; Gemini never required, stays opt-in).
- `ROADMAP.md`.

## [0.1.39] - 2026-06-29

### Fixed (protected-path guard test)

- **`test/hardening.test.ts`**: test "C" asserted a redirect into `~/.claude/fuse-harness/state/...` was blocked,
  which relied on the removed bare `/fuse-harness/` fragment. Repointed the assertion to a genuinely protected
  state path (`.harness/track`) so it validates the guard's intent, not the dropped fragment. (0.1.38 release
  job failed on this test; 0.1.38 was never published.)

## [0.1.38] - 2026-06-29

### Fixed (protected-path guard)

- **`policy/guards/protected-path.ts`**: dropped the `/fuse-harness/` fragment from `PROTECTED_FRAGMENTS`.
  It matched the harness dev repo's own absolute path, so the guard false-blocked every `Write`/`Edit`
  (and read-only `Bash`) inside the source tree. Deployed copies live under `node_modules`, not a
  `/fuse-harness/` path, so the fragment protected nothing real.

## [0.1.37] - 2026-06-28

### Added (native `.env` loading)

- **`config/dotenv.ts`**: the engine now loads `.env` itself at the start of `harness hook`, instead of
  relying on Bun auto-dotenv or `BASH_ENV`. Ports the claude-plugins `services/env-file.ts` reader
  (`export KEY="value"` / `KEY=value`, quotes + `#` comments, CRLF-safe) and merges into `process.env`
  **without overwriting** an already-set var (the real environment always wins). Per-harness home file
  (`~/.claude/.env`, `~/.codex/.env`, `~/.cursor/.env`, `~/.gemini/.env`, …) selected from the detected
  harness, plus the project `<cwd>/.env`. `loadDotenv` is wired into `cli/bin.ts` before `handleHook`, so
  every scope (memory's `NEURAL_MEMORY_HOST`/`GRAPHITI_PORT`, SOLID's `FUSE_*`, …) reads its vars natively.
- 5 new tests (`test/dotenv.test.ts`); 172 tests total.

## [0.1.36] - 2026-06-28

### Added (fuse-memory-neural port → `memory` scope)

- **New `memory` scope** (`PluginScope`, `cli/bin.ts` `validScopes`): ports the four memory-neural
  hook scripts into the engine, all best-effort against a Graphiti server
  (`NEURAL_MEMORY_HOST`/`GRAPHITI_PORT`, 5s `AbortSignal.timeout`, network/IO errors swallowed):
  - `auto-capture-error.py` → `memory/capture-error.ts`: a failed Bash command is stored as a
    Graphiti episode and a `qdrant-find`/`qdrant-store` hint is surfaced as additionalContext.
  - `track-memory-ops.py` → `memory/track-ops.ts`: graphiti/qdrant tool calls are logged to
    `~/.claude/logs/00-memory/operations.log` (rotate 1000→500).
  - `recall-on-session.py` → `memory/recall.ts`: SessionStart detects the project type and recalls
    relevant past lessons from Graphiti, injected as additionalContext.
  - `capture-agent-lesson.py` → `memory/agent-lesson.ts`: SubagentStop stores a finished agent's
    conclusion as an episode (skips explore-codebase/websearch + errored exits).
- The async scopes (`aipilot` + `memory`) are now dispatched through a shared
  `runtime/handle-scope-async.ts` helper, keeping `handle.ts` under the SOLID file-size limit.
- 9 new tests (`test/memory-scope.test.ts`): severity/salience scoring, project detection, log
  rotation, env-overridable base URL, best-effort no-op paths, dispatch routing. 167 tests total.

## [0.1.35] - 2026-06-27

### Added

- **`harness changelog` CLI verb**: ports the changelog-watcher plugin fetch into the engine —
  fetches the Claude Code changelog, parses recent versions, diffs against the saved per-day
  state (~/.claude/logs/00-changelog), and prints JSON {latest, new_since_last_check,
  recent_versions}. Dual-runtime (global fetch). The changelog-scan skill now calls the harness
  instead of a per-plugin script.

### Fixed

- Changelog parser updated to the current docs MDX format (Update label blocks) with the legacy
  header form kept as fallback — the old regex matched nothing on the live page.

## [0.1.34] - 2026-06-27

### Security (#8 — tamper-resistant enforcement state)

- **Freshness from the transcript**: the APEX explore+research gate now verifies prior
  agents from the runtime-authored session transcript (transcript_path), not the
  self-recorded track — so an agent can no longer forge its own state file to pass the
  gate (new src/freshness/agent-evidence).
- **State out-of-tree**: the session track moves from <repo>/.harness/track to
  ~/.claude/fuse-harness/state/<projectHash>/ (src/runtime/paths); the protected-path
  guard now also blocks Bash redirections into state dirs.
- **Integrity**: the track is persisted as an HMAC-signed envelope; load fails closed on
  MAC mismatch (src/tracking/integrity). The key is agent-readable, so the transcript
  evidence is the real guarantee; relocation + guard + HMAC are defense-in-depth.

## [0.1.33] - 2026-06-27

### Fixed

- **Dual-runtime**: the published CLI now runs under Node (npx/npm/global) as well as Bun.
  Replaced all Bun-only APIs (Bun.file/write/spawn/sleep/stdin) and the bun Glob import with
  node:fs / node:child_process / process.stdin via a new src/util/runtime-io compat module —
  fixes the "Cannot find package bun" crash on Node installs (the bin ships a node shebang).

### Changed

- init: generated hook command "npx harness" -> "npx -y @fusengine/harness"; the Claude
  PreToolUse matcher is widened to Write|Edit|Bash so git/install/bash are guarded.

## [0.1.32] - 2026-06-25

### Added (fuse-lessons + fuse-seo ports → harness, ecosystem map → `carto`)
- **New `lessons` scope** (`PluginScope`, `cli/bin.ts` `validScopes`): ports fuse-lessons' 4 events to
  `runtime/lifecycle/lessons/`. `dispatchLessons` routes SessionStart/SubagentStart (inject
  `<root>/MEMORY/LESSON.md` as additionalContext), Stop (cross-project reminder for roots with unsaved
  code edits, throttled via the existing `memory/registry` + `memory/state`), and PostToolUse (arm the
  per-project throttle, wired through `postTrackingSideEffects`). `lessons/state.ts` overrides only the
  two `<root>/MEMORY/` paths, reusing all state/throttle logic from `src/memory`.
- **New `seo` scope**: ports fuse-seo's validate hook. `policy/seo/validate.ts` (`isHtmlLike`,
  `missingSeoElements`) is a zero-dependency regex presence-gate (no cheerio); `lifecycle/seo/post-tool-use.ts`
  denies an HTML-like edit under a `.fuse-seo` marker that is missing any of the 7 SEO elements, via a
  `permissionDecision: deny` PostToolUse response (`seoPostToolUseResponse`).
- **Cartographer ecosystem map** folded into the `carto` scope: `cartoSessionStart` now regenerates BOTH
  the project map AND the plugin ecosystem map (`cartographer/ecosystem-map.ts` ports `generate_map.py`,
  reusing `findMarketplacePlugins`/`readPluginMeta`/`scanPlugin`/`mergeLines`/`writePluginMap`) and emits
  the navigation context as additionalContext.

## [0.1.31] - 2026-06-25

### Added (ai-pilot cache/injection port → harness, new `aipilot` scope)
- **New plugin scope** `aipilot` on `PluginScope`, resolved from the `hook <id> aipilot` CLI arg
  (`cli/bin.ts` `validScopes`). Unlike the other scopes (routed by event), the ai-pilot scope also
  routes by **agent matcher** (the payload's `agent_type`), reproducing the ai-pilot plugin's
  per-agent `hooks.json` entries now that the 11 TypeScript scripts live in the harness.
- **`runtime/lifecycle/aipilot/*`** — the ported cache + injection handlers (each < 100 lines):
  - `dispatch-aipilot.ts` — the (event, agent_type) router (`dispatchAipilot` + `aipilotPostToolUse`).
  - `cache-base.ts` — shared project-hash/age/checksum helpers, reusing `home-state.fusengineCache`
    so ai-pilot caches share the existing `~/.claude/fusengine-cache` tree (no second cache layer).
  - **SubagentStart injectors**: `inject-apex.ts` (matcher "": APEX AGENTS.md + task context +
    cartographer paths, ports `inject-subagent-context.ts`), `inject-explore.ts` (explore-codebase:
    cached architecture or save block, ports `explore-cache-check.ts`), `inject-doc.ts`
    (research-expert: cached docs, ports `doc-cache-inject.ts`), `inject-lessons.ts` (matcher "":
    known-issues, ports `lessons-cache-inject.ts`), `inject-test.ts` (sniper: changed-file list,
    ports `test-cache-inject.ts`).
  - **SubagentStop writers**: `cache-doc.ts` (research-expert synthesis → doc cache, ports
    `cache-doc-from-transcript.ts`), `cache-lessons.ts` (sniper edits → lessons, ports
    `cache-sniper-lessons.ts` — the dead `promote-global-lessons.ts` spawn is dropped),
    `cache-test.ts` (sniper linter output → per-file checksums, ports `cache-test-results.ts`).
  - **SessionEnd**: `analytics.ts` (`logCacheEvent` + `cacheAnalyticsSave`, ports
    `cache-analytics-save.ts`).
  - **PostToolUse (TaskCreate|TaskUpdate)**: `sync-task.ts` + `apex-task-store.ts` (lock + task.json
    create/start/complete + commit reminder, ports `sync-task-tracking.ts`).
  - Support modules: `transcript.ts` (JSONL parse), `source-scan.ts` (monorepo glob + stack detect),
    `lessons.ts` (dedup/merge/categorize), `types.ts` (cache + APEX interfaces).

### Changed (deduplication — fused, not duplicated)
- **`policy/claude-md-context.ts` `buildApexInstruction`** absorbs the richer ai-pilot
  UserPromptSubmit APEX preamble (tracking-file note, 3-agents-in-parallel mandate,
  `${projectType}-expert`, split target, doc-status reminder). The **single** core-scope
  UserPromptSubmit injection now carries it — ai-pilot's `detect-and-inject-apex.ts` is **not**
  re-emitted (its `hooks.json` UserPromptSubmit entry is removed), avoiding a double APEX injection.
- **`runtime/lifecycle/dispatch.ts`** guards the core `SubagentStart`/`SubagentStop`/`SessionEnd`
  cases so the core handlers (`subagentCacheContext` MCP-cache table, `trackAgentMemory`,
  `cleanupSession`) do **not** fire for the `aipilot` scope — the ai-pilot SubagentStart cache
  injectors are emitted via separate `hooks.json` entries, so there is no double emission, and the
  MCP cache continues to be served by the core scope.
- **`runtime/handle.ts`** runs the async `dispatchAipilot` before the sync lifecycle dispatch and
  routes `aipilot` PostToolUse TaskCreate/TaskUpdate to `aipilotPostToolUse`.

## [0.1.30] - 2026-06-25

### Added (lifecycle/session/context port: cartographer + security-expert + changelog-watcher hooks → harness)
- **New plugin scopes** `carto` | `security` | `changelog` on `PluginScope`, resolved from the
  `hook <id> <scope>` CLI arg (`cli/bin.ts`), routing three more plugins' Python hooks into the harness:
  - **cartographer** — pure policy `policy/cartographer/*` (`indicators.ts` project-detection +
    exclude sets, `frontmatter.ts` YAML field/body parse, `entry.ts` index-line regex parse,
    `describe.ts` heading/comment/desc extraction) and runtime effects
    `runtime/lifecycle/cartographer/*` (`fs-util.ts` tree walk + file desc, `merge.ts` enriched-
    sidecar-aware index merge, `write-tree.ts` recursive `index.md` generation, `project-map.ts`
    project-tree map, `track-enrichment.ts` `.enriched.json` sidecar, `session-start.ts`).
    **SessionStart (carto)** generates the project map (ports `generate_project_map.py`);
    **PostToolUse (carto, Edit/Write)** tracks enriched descriptions (ports `track-enrichment.py`).
    *(The plugin ecosystem map `generate_map.py` and its libs are NOT ported and stay in Python.)*
  - **security-expert** — `runtime/lifecycle/security/*` (`skill-state.ts` shared
    `~/.claude/logs/00-security` state + UTC date/iso helpers, `check-skill.ts` **non-blocking**
    advisory `permissionDecision: allow` + `additionalContext` when the security skill is unread,
    `track-skill-read.ts`, `track-mcp.ts`). **PreToolUse (security)** is advisory-only — it never
    runs the core APEX/SOLID/file-size gate chain. Ports `check-security-skill.py`,
    `track-skill-read.py`, `track-mcp-research.py`.
  - **changelog-watcher** — `runtime/lifecycle/changelog-research.ts`: **PostToolUse (changelog)**
    logs Exa/WebFetch/WebSearch research to `~/.claude/logs/00-changelog`. Ports
    `track-watch-research.py`.
- **Post-tracking side-effects** `runtime/lifecycle/post-tracking.ts` (`postTrackingSideEffects`):
  routes PostToolUse to the carto/security/changelog trackers by scope (side-effects only, no stdout),
  wired into `handle.ts`; security PreToolUse advisory wired into `handle-pre.ts`.

### Added (lifecycle/session/context port: core-guards + solid + claude-rules hooks → harness)
- **Lifecycle hook dispatch** (`runtime/lifecycle/*` + `runtime/lifecycle-bridge.ts`): ports
  the remaining Python hooks of the core-guards, solid, and claude-rules plugins into the
  harness, routed by event in `handleHook` via a new `scope` (`core` | `solid` | `rules`)
  resolved from the `hook <id> <scope>` CLI arg:
  - **SessionStart (core)** `lifecycle/session-start.ts`: inject `~/.claude/CLAUDE.md` + dev
    context (git branch/status + project type) and run the cache/state cleanups — ports
    `inject-claude-md.py`, `load-dev-context.py`, `cleanup-session-states.py`,
    `cleanup-old-caches.py` into one call.
  - **SessionStart (solid)** `lifecycle/solid-detect.ts`: detect the SOLID profile and append
    `SOLID_*` exports to `CLAUDE_ENV_FILE` — ports `solid/detect-project.py`.
  - **SessionStart + UserPromptSubmit (rules)** `lifecycle/inject-rules.ts`: concatenate
    `${CLAUDE_PLUGIN_ROOT}/rules/*.md` as `additionalContext` — ports `claude-rules/inject-rules.py`.
  - **PostToolUse (core, Write/Edit)** `lifecycle/track-changes.ts` + `lifecycle/post-edit-ts.ts`:
    cumulative session-change tracking → sniper reminder, and eslint/prettier report — ports
    `track-session-changes.py` + `post-edit-typescript.py`.
  - **SubagentStart** `lifecycle/subagent-cache.ts` (MCP cache table, ports `inject-context-cache.py`),
    **SubagentStop** `lifecycle/agent-memory.ts` (ports `track-agent-memory.py`),
    **TeammateIdle** `lifecycle/teammate-idle.ts`, **PostToolUseFailure** `lifecycle/tool-failure.ts`,
    **PreCompact** `lifecycle/pre-compact.ts`, **SessionEnd** `lifecycle/session-end.ts`,
    **InstructionsLoaded** `lifecycle/instructions-loaded.ts`.
- **Shared state/cleanup helpers**: `runtime/home-state.ts` (the `_shared/state_manager` +
  `cache_io` equivalent: `~/.claude/fusengine-cache` paths, session-state load/save, session-id
  sanitize), `runtime/fs-cleanup.ts` (mtime/TTL file removal, log trim, whitelisted-subtree purge,
  empty-dir prune), `runtime/dev-context.ts` (git + project-type context). `handleHook`'s
  PreToolUse pipeline extracted to `runtime/handle-pre.ts` to keep each module < 100 lines.

### Added (finishes the plugin→harness port: the last two context-injection hooks)
- **CLAUDE.md + APEX UserPromptSubmit injection** (`policy/claude-md-context.ts`):
  reads `~/.claude/CLAUDE.md` and, when the prompt matches the FR/EN dev-verb regex,
  prepends the APEX instruction (project type detected from the cwd; max-lines from
  the single-source `resolveMaxLines()`). Emitted as `additionalContext` from
  `handleHook` on UserPromptSubmit (alongside the existing brainstorm flag). Ports
  the plugin's `core-guards/scripts/user-prompt/read-claude-md.py`.
- **APEX Task PreToolUse injection** (`policy/apex-task-context.ts`): when the
  project's `.claude/apex/` exists, reads `task.json` and injects the APEX sub-agent
  context (`additionalContext`) for `tool === "Task"`. Ports the plugin's
  `ai-pilot/scripts/inject-apex-context.py`.
- **`runtime/inject-context.ts`**: thin renderers wiring both behaviors into the
  Claude `additionalContext` response shape; consumed by `handleHook`.

## [0.1.29] - 2026-06-25

### Added (completes the plugin→harness port; nothing left in the plugins' `_shared`)
- **DRY duplication gate** (`runtime/dry.ts`): extracts declared symbols from a
  Write/Edit, greps the codebase (module-boundary aware, fail-open on grep
  error/timeout), and blocks when 2+ existing declarations clash. Wired into
  `gate()` after the APEX gates.
- **`detectModularArchitecture`** (`policy/detect-project.ts`): FuseCore (Laravel)
  and `modules/`-based Next.js sub-architecture detection.
- **pre-commit gate** (`runtime/precommit.ts`): runs eslint/tsc/prettier/ruff on a
  `git commit` and blocks on errors (effectful, fail-open, never auto-fixes).
- **design pipeline** (`policy/design/*` + `runtime/design.ts`): the full design-agent
  state machine ported from the plugin — phase ordering, HTML/CSS-only writes, screenshot
  quota + scroll-before-screenshot, inspiration/identity gating, Gemini create_frontend
  validation (OKLCH/forbidden-fonts/reference-URL), and post-write content checks
  (accessibility/AI-slop/hardcoded-colors) as non-blocking warnings. Activated by the
  design-agent flag; inert for every other agent. Gemini gates are opt-in via
  `FUSE_DESIGN_GEMINI` (off by default).
- **modular architecture gate** (`runtime/modular.ts`): enforces Next.js `modules/`
  (app/ conventions + cross-module imports) and Laravel FuseCore (app/ domain ban,
  `module.json`, cross-module use) — only when the architecture is detected on disk.
- **framework SOLID rules** (`policy/framework-solid*`): per-framework rules beyond the
  generic file-size/interface guards — React (custom hooks under `hooks/`), Next.js
  (`'use client'` directive, adaptive 150-line limit for route files), Laravel
  (interfaces under `Contracts/`, fat-controller 80-line), Swift (`@MainActor`/`Sendable`,
  protocols under `Protocols/`, adaptive 150 for View/Screen). Counts the full on-disk
  file on Edit; skips vendor/build dirs.
- **skill triggers** (`policy/skill-triggers.ts` + `skill-patterns/*`): detects a library
  API in written code (e.g. `useActionState`→react-19, Prisma→prisma-7, shadcn markup→
  shadcn skill) and blocks until the matching sub-skill ref was read in-session;
  `*-shadcn` required only in shadcn projects. `requiredArchSkill` forces the
  modular-architecture skill (`solid-nextjs`/`fusecore`).

### Fixed
- **file-size**: `countLines` counts CODE-ONLY lines (skips blank + `//`/`*`/`/*`
  comment lines), matching the original; `#` stays code (Rust/C).

## [0.1.28] - 2026-06-24

### Fixed (security)
- **macOS raw-disk bypass**: the `dd` block missed `/dev/rdisk` (the raw, faster,
  more destructive macOS path), so `dd of=/dev/rdisk2` slipped through — widened to
  `r?disk` (+ `xvd`).
- **ReDoS in `stripHeredoc`**: the lazy dot-all + backreference could backtrack
  catastrophically (O(n³)); rewrote as a linear two-phase scan (backreference-free
  opener + per-heredoc closer search), preserving `<<-` indented-closer semantics.

## [0.1.27] - 2026-06-24

### Fixed (port parity — gaps found by a Python↔TS content diff)
- **security**: the `dd` block matched only `if=/dev/zero of=/dev/`; widened to any
  `dd … of=/dev/<disk>`. Added `del` to the ask list, and a `stripHeredoc()` pass so
  a heredoc body no longer triggers false positives.
- **refs routing**: keyword scoring is now case-insensitive (lowercased haystack),
  matching the original.
- **refs loading**: `level` is now inferred from the path when the frontmatter omits
  it (`templates/`→template, SOLID slug→principle, else architecture) — restores the
  principle/template hoisting for refs without an explicit `level:`.

## [0.1.26] - 2026-06-24

### Changed
- `loadRefs` now accepts a **path-delimiter list of directories** (`dir1:dir2`,
  cross-platform via `path.delimiter`) and scans each, so `FUSE_HARNESS_REFS` can
  point straight at the spread `solid-*/references` dirs — no copy/aggregation step,
  no content duplication, and only the SOLID ref dirs are scanned (fast).

## [0.1.25] - 2026-06-24

### Changed (framework-aware SOLID routing)
- `scoreReferences` now weights each `applies-to` glob match by **specificity**
  (`+10` base + `+5` per literal path segment), so the most specific skill wins:
  `**/app/**/*.tsx` (nextjs) > `**/*.tsx` (react) > `**/*.ts` (generic). The
  solid-read gate routes to the right language/framework skill purely from the
  skills' declared globs — no hardcoded framework list. Add a `solid-vue` skill
  with `applies-to: **/*.vue` and it routes automatically.

### Planned
- OIDC Trusted Publishing once the npmjs trusted-publisher entry matches the
  workflow (currently the registry returns "package not found" at token exchange).

## [0.1.24] - 2026-06-24

### Changed
- No functional change. Publish continues via `NPM_TOKEN` + provenance. (An OIDC
  trusted-publishing switch was attempted but deferred — the npmjs trusted-publisher
  entry doesn't yet match this workflow.)

## [0.1.23] - 2026-06-24

### Changed
- Repo is now **public** → the publish workflow emits a signed **provenance**
  attestation (`npm publish --provenance`, sigstore). First release with provenance.

## [0.1.22] - 2026-06-24

### Documentation / packaging
- `package.json`: added `repository` / `homepage` / `bugs` — so npmjs links back to
  the repo and resolves the README's relative links.
- README: replaced the single vague `docs/` link with a **Documentation** table
  (absolute GitHub links to each guide + CHANGELOG, so they work on npmjs too).

## [0.1.21] - 2026-06-24

### Documentation
- README: added an **"Extend it"** section with a `registerGuard` example +
  the two-tier / fail-closed note, so the shipped npm landing page documents the
  0.1.20 extensibility API.

## [0.1.20] - 2026-06-24

### Added (ideas mined from OpenClaw + hermes-agent)
- **Fail-closed enforcement**: `runGuards` and the runtime `gate` (`evaluate` +
  `evaluateApex`) now wrap execution — a guard/gate that **throws** returns a block
  (`FAIL_CLOSED`) instead of crashing the hook and letting the tool run ungated.
  Closes a fail-**open** hole (a bug degrades to "too strict", never "no protection").
- **Extensible guard chain** (two-tier, OpenClaw-style): `registerGuard(fn)` adds a
  user guard that runs **after** the privileged core chain (the core can't be
  bypassed); `clearUserGuards()` resets. Turns the fixed 5-guard chain into an
  extensible policy engine — users add project rules without forking.

### Note
- Adopted only the in-scope, non-babysitting ideas from the OpenClaw/hermes audit;
  secret-redaction, gateway, agent-loop, and memory features were deliberately skipped.

## [0.1.19] - 2026-06-24

### Fixed (parity audit — last inert gap closed)
- **cache-served docs now count as consulted**: when `mcpPreIntercept` serves a
  fresh context7/exa result from cache, `handleHook` records the doc consultation
  (`recordActivity` `doc`), so `docConsultedGate` is satisfied on cross-session
  cache hits — previously only a live MCP call recorded it (the cached branch was
  inert). Cleaner than the plugin's `read_paths`: recorded at serve-time, no
  provider-prefixed cache filenames needed. `mcpPreIntercept` now returns
  `{ stdout, docSource? }` (was a bare string).

### Parity
- This closes the last portable enforcement gap from the 8-agent audit. Remaining
  differences are by design (project-local `.harness/` state, fail-closed
  bash-write whitelist, no Ralph mode, pre-commit-lint out of scope).

## [0.1.18] - 2026-06-24

### Added (parity audit — file-size on-disk + agent exemption)
- **file-size now checks the existing on-disk file**, not just the incoming
  payload: an **Edit** on an already-oversized file blocks (judges `existingLines`
  read by the runtime gate), while a **Write** judges its full new content (so it
  can legitimately shrink a large file). `Explore`/`Plan` agents are exempt.
- `PolicyContext` gains `agentType` + `existingLines`; `GateInput` gains
  `agentType`; `normalizeEvent` extracts `agent_type` / `subagent_type`.

### Documentation
- Refreshed `docs/guards.md` to the current coverage (security commands, Go/Java
  interfaces, git ask set, file-size on-disk, verbosity caps).

## [0.1.17] - 2026-06-24

### Added (parity audit — pattern coverage)
- **git**: `GIT_ASK` += `git commit` / `git add` / `git branch -d` (ask). NOTE:
  with Ralph mode gone, these now prompt on every use — drop the 3 patterns if too noisy.
- **security**: critical += `shred` / `fdisk` / `diskutil erase` / redirect to
  `/dev/{sda,hda,nvme}` / `rm -rf /{etc,usr,var,bin,sbin,…}`; ask += `su` / `doas` /
  `passwd` / `rm` / `unlink`.
- **interface-separation**: now covers **Go** (`type Foo interface`) and
  **Java/Kotlin** (`interface`/`record`), plus widened paths (Python `controllers/`/
  `routes/`, PHP `Handlers/`, Swift `Components/`).
- **verbosity**: caps exa `tokensNum` ≤ 2000 and Context7 `tokens` ≤ 2000 (was numResults only).

## [0.1.16] - 2026-06-24

### Fixed (parity audit — inert gates now actually fire)
- **agent-quality**: `activityFor` derives agent `quality` from the POST response
  length (≥500 → `sufficient`); `recordActivity` persists it, so `agentsFresh`
  finally rejects empty/insufficient agent runs (was structurally inert).
- **brainstorm**: `handleHook` now handles a `UserPromptSubmit` payload —
  `detectCreationIntent(prompt)` → `recordBrainstormRequired`, so `brainstormGate`
  can actually fire (the flag was never set before).

### Removed
- **`dispatchHook`** (`cli/hook.ts`) + its test — dead, stateless, APEX-bypassing
  entry point superseded by `handleHook`. Removed to kill the footgun. Documented
  the thin-adapter (stateless) vs `handleHook` (full) distinction in `docs/adapters.md`.

## [0.1.15] - 2026-06-23

### Added
- **git-ask parity**: `evaluate` now wires `GIT_ASK` (push/checkout/reset/merge/
  rebase/stash/clean/rm/mv/restore/revert/cherry-pick) → a `Prompt{kind:"ask"}`
  confirmation (destructive ops stay a hard `deny`). Previously `GIT_ASK` was
  defined but never consumed.

### Changed
- **TTL honored**: `harness hook` now reads `FUSE_ENFORCE_TTL_SEC` (`resolveTtlSec`)
  and feeds it as the gate window; `DEFAULT_WINDOW_MS` is now **2 min** (was a
  fixed 4 min), matching the plugin + installer default.
- **De-duplicated install patterns**: `installGuard` consumes `PROJECT_INSTALL` /
  `SYSTEM_INSTALL` from `policy/patterns` (added `dnf` / `pacman`); removed the
  guard's duplicate regexes.

## [0.1.14] - 2026-06-23

### Changed
- **Unified, neutral project state dir.** All per-project state now lives under
  one `<root>/.harness/` (was scattered: `.claude/harness/`, `MEMORY/`), so it no
  longer hides inside one harness's config dir:
  - `.harness/track/` (session tracks), `.harness/cache/` (MCP/WebFetch),
    `.harness/memory/` (`LESSON.md` committable + `state.json` machine-local).
  - `harness init` now also writes a selective `.harness/.gitignore`
    (ignores track/cache/state.json, keeps `LESSON.md`).
- **New `config/layout` — single source of truth.** `projectLayout(root)` derives
  every path; `runtime/storage`, `memory`, and `init` all consume it (nothing
  hardcodes a dir name). `harnessTrackDir(id, root)` → `harnessStateDir(root)`;
  `memory` gains `lessonsFileFor(root)`. The HOME roots registry is unchanged.

## [0.1.13] - 2026-06-23

### Documentation
- Rewrote the **README** as a full quickstart: install, `harness init/hook/check`,
  the 10 guards + APEX gates, env vars, the subpath-exports table, and library
  usage — reflecting the complete engine (was the pre-0.1.0 description).
- Added **typedoc**: `bun run docs:api` generates the API reference to `docs/api/`
  (288 pages, 0 errors). `typedoc.json` + `docs:api` script.
- New module guides `docs/guards.md` + `docs/runtime.md`; refreshed `docs/index.md`.

## [0.1.12] - 2026-06-22

### Added
- **MCP interception** — the last two portable guards, wired into `handleHook`:
  - **verbosity cap** (`policy/verbosity`: `capVerbosity`) — caps exa MCP calls to
    3 results (Context7 has no verbosity knob); emitted as an input mutation.
  - **cache lookup/store** (`cache/store`: `mcpCacheKey` / `cacheLookup` / `cacheStore`)
    — a keyed, mtime-TTL'd file cache. On a pre MCP/WebFetch event a fresh hit is
    served (deny + cached content); the post event stores the response.
  - `runtime/mcp` (`mcpPreIntercept` / `mcpPostStore`) routes MCP tool events for
    Claude/Codex/Gemini (harnesses that support input mutation / cache serving).

### Note
- This completes all 10 portable enforcement guards from `core-guards`. The
  remaining plugin pieces (agent prompts, rules/skill content, injection) are
  Claude-specific content, not portable library logic.

## [0.1.11] - 2026-06-22

### Added
- **agent-quality threshold**: `recordAgent(name, ts, quality?)` + `agentsFresh`
  now ignores `insufficient`-quality agent calls (matches the plugin's
  response-length gate).
- **trivial-edit fast path**: the gate lets up to `TRIVIAL_BUDGET` (4) tiny
  (< 5 lines), non-`replace_all` edits per window through without the APEX gates
  (`recordTrivialEdit` / `trivialCount`, sliding window in the track).
- **brainstorm gate**: `brainstormGate` blocks creating new files when
  `brainstormRequired` and the brainstorming agent isn't fresh; `detectCreationIntent(prompt)`
  + `recordBrainstormRequired` provide the signal (harness wires it on UserPromptSubmit).

## [0.1.10] - 2026-06-22

### Added
- **policy/guards** — five portable enforcement guards composed into `evaluate()`
  via a `runGuards` chain (first firing guard wins, ahead of git + file-size):
  - `bashWriteGuard` — blocks `python3 -c` / `sed -i` / redirects to code files.
  - `installGuard` — asks before `npm/pip/brew/...` installs.
  - `securityGuard` — blocks `rm -rf /`, fork bombs, `curl | sh`; asks on `sudo`.
  - `interfaceSeparationGuard` — blocks top-level interface/type/protocol in
    component/view/controller files (Interface Segregation).
  - `protectedPathGuard` — hard-denies edits to `.claude/plugins|logs|cache`, `.git/`.
  Shared `GuardContext` type; all exported via `./policy`. (Authored in parallel by a guard team.)

## [0.1.9] - 2026-06-22

### Added
- **refs/loader**: `loadRefs(dir)` scans a directory recursively for `.md`
  reference files and parses each frontmatter into a `RefMeta` (tolerant of
  kebab/camel keys via `toRefMeta`). The content is the consumer's — point it at
  ANY refs dir. This activates `solidReadGate` (previously inert without a source).
- **runtime/handle**: `HandleOptions.refsDir` — when set, `handleHook` loads the
  refs and feeds them to the gate. `harness hook` reads it from `FUSE_HARNESS_REFS`.

## [0.1.8] - 2026-06-22

### Changed
- **init** now wires BOTH phases: a PRE hook to gate edits AND a POST hook
  (catch-all → `activityFor` filters) so the track fills automatically. Claude/
  Codex add `PostToolUse`, Gemini adds `AfterTool` (regex `.*`), Cursor keeps
  `afterFileEdit`, and Cline gets a second executable `.clinerules/hooks/PostToolUse`.
- `initFor(id)` now returns `InitFile[]` (was a single file); `harness init`
  writes all of them. `harness init` is now plug-and-play end-to-end.

## [0.1.7] - 2026-06-22

### Added
- **runtime/handle**: `handleHook(id, payload, {now, cwd})` — the full loop.
  On a PRE event it gates the tool-use (stateless guards → APEX gates from the
  track) and returns the native response; on a POST event it records the
  activity. `harness hook <id>` now runs this end-to-end.
- **runtime/normalize**: `normalizeEvent(id, payload)` → uniform `{phase, tool,
  input, sessionId, filePath, content, command}` across Claude/Codex/Gemini/
  Cursor (`tool_name`/`tool_input`) and Cline (nested `preToolUse`).
- **runtime/respond**: `respond(id, prompt)` maps a portable `Prompt` to each
  harness's native block/ask response.

### Changed
- `harness hook` is now async and stateful (was the sync, stateless `dispatchHook`,
  still exported for simple use).

## [0.1.6] - 2026-06-22

### Added
- **runtime/storage**: `harnessTrackDir(id, projectRoot)` — stores each harness's
  track under its OWN config dir (`.claude/harness`, `.codex/harness`,
  `.cursor/harness`, `.gemini/harness`, `.clinerules/harness`; `.fuse-harness`
  fallback), next to its hooks, scoped per project.
- **runtime/activity**: `activityFor(event)` maps a live tool-use to an
  `Activity` to record — MCP doc calls (`context7`/`exa`, any separator) → `doc`,
  `Task` + `subagent_type` → `agent` (bare name), a read of a `.md` → `ref`.
  Tool names verified against each harness's 2026 hook docs. Closes the
  auto-fill loop: adapter PostToolUse → `activityFor` → `recordActivity`.

## [0.1.5] - 2026-06-22

### Added
- **runtime** — the end-to-end glue between tracking and the gates:
  - `gate(input)`: runs the stateless guards (file-size, git) first, then loads
    the session track and runs `evaluateApex` (freshness → docs → SOLID). First
    block wins; APEX applies only to code edits.
  - `recordActivity(file, activity)`: a discriminated-union (`agent` | `doc` |
    `ref`) PostToolUse recorder that persists into the track.
  - `trackFile(sessionId, baseDir?)` path resolver; `REQUIRED_AGENTS` +
    `DEFAULT_WINDOW_MS` (4 min). New subpath export `./runtime`.

## [0.1.4] - 2026-06-22

### Added
- **tracking** — the session-state layer that feeds `evaluateApex`. Immutable
  record helpers (`recordDoc`, `recordRefRead`, `recordAgent`) + `agentsFresh()`
  (all required agents seen within a window), and a `loadTrack`/`saveTrack` store.
  An adapter records activity on PostToolUse and reads it back to build the
  `ApexContext` on PreToolUse.
- **policy/apex**: `freshnessGate` — blocks when the prior agents (explore +
  research) are not fresh (`agentsFresh: false`); added to the default gate chain
  ahead of docs + SOLID. New `ApexContext.agentsFresh` field.

## [0.1.3] - 2026-06-22

### Added
- **policy/apex** — `evaluateApex(ctx)`: composes the APEX gates as a
  chain-of-responsibility (first failing gate's `Prompt` wins). Ships
  `docConsultedGate` (Context7 + Exa via `isDocConsulted`) and `solidReadGate`
  (the routed required SOLID refs must be read, via `routeReferences`). Pure;
  the harness adapter supplies the session state (`authorizations`, `refs`,
  `refsRead`). Gates are individually exported + overridable.

## [0.1.2] - 2026-06-22

### Added
- **adapters/codex**: OpenAI Codex CLI adapter. Codex's `PreToolUse` hook (2026)
  is Claude-compatible (`tool_name`/`tool_input` → `hookSpecificOutput.permissionDecision`),
  so it reuses the Claude guard. Codex is now `hook`-mode in `detect` (was `cli`).
- **init**: `harness init [id]` writes the wiring file for the detected (or named)
  harness — `.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`,
  `.gemini/settings.json`, or an executable `.clinerules/hooks/PreToolUse` — each
  pointing at `npx harness hook <id>`. Formats verified against each harness's docs.
- **hook dispatcher**: `harness hook <id>` reads a hook payload on stdin, routes it
  to the matching adapter, and prints the harness's native response.

### Changed
- The bin is now **`harness`** with subcommands (`check` | `init` | `hook`),
  replacing the single-purpose `harness-check`.

## [0.1.1] - 2026-06-22

### Added
- **adapters/cursor** (`beforeShellExecution` blocks via `permission: deny`;
  `afterFileEdit` observe-only), **adapters/cline** (`PreToolUse` → `cancel`),
  **adapters/gemini** (`BeforeTool` → `decision: deny`). Schemas verified against
  each harness's 2026 hook docs. All map their payload → `evaluate()` → native response.
- **cli** + **`harness-check`** bin: a cli-mode entry for harnesses without hooks
  (Aider, Windsurf, OpenHands). Run it as a pre-commit step — checks staged files
  (`git diff --cached` + `git show :path`) against the policy core, exits non-zero on a violation.
- Subpath exports for the new adapters + `./cli`; `bin.harness-check`.

## [0.1.0] - 2026-06-22

### Added
- **detect**: `detectHarness()` / `detectMode()` — 12 harnesses (Claude Code,
  Codex, Cursor, Cline, Gemini, opencode, Windsurf, Copilot, Aider, Kiro,
  Goose, Amp) via env signals + `AGENT`/`AI_AGENT` standards.
- **policy**: `evaluate(ctx)` unified surface; `evaluateFileSize`,
  `detectProjectType`, `detectFramework`, git/install guard patterns.
- **config**: env-driven `resolveTtlSec` / `resolveMaxLines` with robust parse.
- **cache**: `compactMarkdown`, `queryHash`, `jaccardSimilar`, atomic I/O,
  MCP `extractText`.
- **freshness**: `isDocConsulted` (Context7 + Exa), trivial-edit counter.
- **refs**: frontmatter parsing, glob→regex, SOLID reference scoring/routing.
- **state**: directory locks, daily APEX state, task.json helpers.
- **memory**: per-project lessons throttle + multi-project registry by git root.
- **statusline**: formatters, ANSI colors, progress/gradient bars.
- **util**: compact-json, `.git`-first project root, atomic JSON I/O, hashing.
- **adapters/claude**: stdin → policy → `hookSpecificOutput`.
- README, docs/, CI (`bun test` + `tsc` on every PR). 48 tests, 0 type errors.

### Notes
- Bun-native: `exports` points at TS source, no build step.
- Ported verbatim from the fusengine Claude Code plugins (TypeScript + Python).

# adapters — wiring the core into a harness

The core (`policy`, `cache`, …) is harness-agnostic. An **adapter** is the thin
shim that (1) parses a harness's event payload, (2) calls the core, (3)
serializes that harness's native response. Adapters are the *only*
harness-specific code.

> **Thin (stateless) vs full (stateful).** An adapter's `guard()` runs only the
> **stateless** policy (`evaluate`: file-size, git, security, bash-write,
> install, interface, protected-path) — it judges the *command*, not the
> *session*. The **full** enforcement (stateless **+** the stateful APEX gates:
> freshness, doc-consulted, SOLID-read, brainstorm + activity recording) only
> runs through **`handleHook`** (i.e. `harness hook <id>`), which reads/writes
> the session track. Use `handleHook` for real enforcement; the thin adapter
> exports are a fast stateless building block, not the complete gate.

## Compatibility matrix

**No harness enforces the full policy the same way.** This is the ceiling per
adapter, not a formatting difference — read the "Known limit" column before
assuming a gate that works on Claude Code also works elsewhere.

| Harness | Adapter file | PreToolUse coverage | Lifecycle events | Known limit |
|---|---|---|---|---|
| **claude-code** | `adapters/claude/index.ts` | Full: `evaluate` + APEX gates via `handleHook` | 14 event types implemented in `runtime/lifecycle/dispatch.ts` (SessionStart, SessionEnd, SubagentStart/Stop, Stop, PreCompact, PostCompact, TaskCompleted, TeammateIdle, PostToolUseFailure, InstructionsLoaded, UserPromptSubmit, plus Pre/PostToolUse) | Only PreToolUse+PostToolUse are wired by `harness init` (`init/templates.ts:18-27`); the other 12 event types require the consumer's own `.claude/settings.json` to route them. |
| **codex** | `adapters/codex/index.ts` + `adapters/codex/apply-patch.ts` | `Bash \| apply_patch` matcher, PostToolUse (`init/templates.ts:29-38`). **`apply_patch` edits are gated**: the patch text is parsed per file, each hunk runs the file gates (protected-path, file-size, DRY) and one violating hunk denies the whole patch (`runtime/apply-patch-gate.ts`, sim scenarios 22-23). `ask` is downgraded to an explicit deny (`respond.ts`) — Codex fails open on unsupported shapes; the deny now carries a `CONFIRM <code>` recourse (`runtime/confirm/`, see below). | none wired | Upstream: Codex does not always enforce a correct `apply_patch` deny (openai/codex#27833) — the harness emits the right verdict, enforcement is Codex's. Do not add a Codex `PermissionRequest` path until `respond()` emits Codex's own wire shape (`codex/index.ts`). |
| **cursor** | `adapters/cursor/index.ts` | The full runtime normalizes native `beforeShellExecution.command` and `preToolUse` `Shell` as `Bash`; `Write` maps to `Edit`. Policy `ask` degrades to native `permission:"deny"` because Cursor does not reliably apply `ask` on `preToolUse`. The public shell/tool adapter uses the same extractor. | `afterFileEdit` observation | `afterFileEdit.edits[]` is fanned out for post consumers and framework visibility, but the edit has already happened: this path remains **advisory only** and cannot retroactively block or roll back the write. |
| **gemini-cli** | `adapters/gemini/index.ts` | `BeforeTool` denies via `{decision:"deny",reason}` (lines 22-36) | none | Thin stateless adapter — no session track, no APEX gates reachable through it. |
| **cline** | `adapters/cline/index.ts` | `PreToolUse` only; block → `{cancel:true}`, non-block → `contextModification` (lines 24-36) | none | Same as gemini-cli: stateless guard only, `PreToolUse` cannot modify tool parameters (per docs.cline.bot). |
| **hermes** | `adapters/hermes/index.ts` | `pre_tool_call` proven: reuses the Claude stdin reader, blocks via `{decision:"block",reason}` (lines 12-36) | untested — no lifecycle dispatch wired for Hermes in this repo | `ask`/`inform` degrade to non-blocking `{context}` — Hermes "has no interactive ask state" (lines 27-28). |
| **kimi** | `adapters/kimi/index.ts` | `PreToolUse` denies via the camelCase JSON channel `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` on stdout at **exit 0** (verified live against kimi-code v0.27.0 — exit 2 with stderr = reason also blocks, but is not required) — only `deny` is documented. `ask` is **downgraded to deny** prefixed `[downgraded from ask — Kimi Code has no interactive approval]`, with a `CONFIRM <code>` recourse appended (`runtime/confirm/`, see below); `inform` rides plain stdout text at exit 0, never wrapped in JSON. Blocking events: `UserPromptSubmit`, `PreToolUse`, `Stop`. | Observation only: `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionResult`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `StopFailure`, `Interrupt`, `PreCompact`, `PostCompact`, `Notification` — Kimi delivers them but **ignores any response**, so no verdict can be returned from them. | A **hook** cannot request approval — Kimi's `ask` lives in a parallel, hook-unreachable system (`[[permission.rules]] decision = "ask"` in `config.toml`), hence the ask→deny downgrade. Hooks are configured **only** in the global `~/.kimi-code/config.toml` (no project-local hooks file), so `harness init` writes no kimi wiring — see [Kimi Code — manual wiring](#kimi-code--manual-wiring). **Fail-open by design**: any exit code other than 0/2, a timeout, or a crash lets the call through. Stdin payload is snake_case and carries only `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input.command` and an undocumented `tool_call_id` (unused here) — no `transcript_path`, no `permission_mode`, no `tool_response`. Verified live against kimi-code v0.27.0 for `PreToolUse`/`Bash`. Instructions file is `AGENTS.md`, not `CLAUDE.md`. |

### PRD capabilities

Opt-in (`FUSE_PRD=1`), documented in full at [prd.md](./prd.md). Coverage
splits by **capability**, not by adapter — a single per-adapter verdict
would be misleading here:

| Capability | claude-code | codex | cursor | kimi | cline / gemini-cli / hermes |
|---|---|---|---|---|---|
| Write ownership block | full | full | consultative only (never blocks) | consultative only (never blocks) | full, if the consumer wires `PreToolUse` |
| Bash-under-`prd/` deny | yes | yes | yes | yes | yes |
| `SubagentStart` slice injection | yes | yes | **no** — the slice IS built (identical to claude-code's), but `adapters/cursor/respond.ts`'s `toCursorLifecycleResponse` collapses any non-denied `subagentStart` to bare `{"permission":"allow"}`, dropping it; measured byte-identical output with a matching PRD assignment, with no router at all, and with `FUSE_PRD` unset | delivered, ignored (observation-only) | gemini-cli: yes, delivered — routed through `respond()`'s native "inform" shape, then re-wrapped by `joinContextResponses` into the shared Claude-style `hookSpecificOutput.hookEventName/additionalContext` envelope plus a `[NOTE]` title line (not gemini-cli's own minimal shape, but the text arrives). hermes: yes, delivered — same Claude-style `contextResponse` as claude-code; Hermes's own documented non-blocking shape is `{context}`, not `hookSpecificOutput`, so whether a real Hermes client reads it is unverified. cline: yes, delivered in its own native `{contextModification}` shape — `joinContextResponses` keeps whichever envelope its parts came from instead of assuming the Claude one (measured 476 bytes where an earlier build emitted none; the six other targets stay byte-identical, gemini-cli 529 = 529, the Claude-family four 506 = 506) |
| `SubagentStop` block-once | yes | yes | delivered, response ignored | delivered, response ignored | yes — each in its OWN native block shape via `respond()`: gemini-cli `{"decision":"deny","reason"}`, cline `{"cancel":true,"errorMessage"}`, hermes `{"decision":"block","reason"}` (via `blockResponse`, which happens to match Hermes's own documented block contract). Block-once verified: 1st call blocks, an identical replay is silent (empty stdout) on all three, under both the default journal-based session track and legacy `FUSE_TRACK_JOURNAL=0` |
| Lead `Stop` block-once | **no** — the gate itself is correct and fires when invoked (verified byte-for-byte), but claude-code's real marketplace Stop hook always calls the harness with `--sound stop`, which exits in `maybePlaySound()` before stdin is read — the gate is never reached | yes | not applicable | **no** — same root cause as claude-code: Kimi's own marketplace Stop hook also always carries `--sound stop` | yes — same per-adapter native shapes and block-once behavior as `SubagentStop` above (gemini-cli/cline/hermes), verified under both tracking modes |

Cursor and Kimi never send an agent-identity field on a Write/Edit
payload, and a Cursor sub-agent's write runs under a session ID
unrelated to its own `SubagentStart` event — so per-write ownership
enforcement isn't possible on either target. Both stay consultative
permanently; the PostToolUse cross-check is the only enforcement there.

## `CONFIRM <code>` — recourse for a degraded `ask`

The harnesses above downgrade `ask` to a hard `deny`: Kimi's binary
short-circuits on `hookSpecificOutput?.permissionDecision !== "deny"`, Codex
fails a hook open on the unsupported `ask` shape, and Cursor maps `ask` to
`permission:"deny"`. Claude Code is unaffected — its native `ask` still shows
an interactive confirmation, and this mechanism never touches it
(`src/runtime/confirm/confirm-gate.ts`'s `DEGRADES_ASK_TO_DENY` set is
`{"codex", "kimi", "cursor"}`).

When an `ask` about to be degraded carries a command, the deny message gets a
short 4-hex-char code appended. Retyping `CONFIRM <code>` in the next prompt
authorizes that **exact** action once — parsed in `src/runtime/confirm/confirm-submit.ts`
(`handleConfirmSubmit`, wired from `UserPromptSubmit` in `handle.ts`) via a
`CONFIRM_RE` tolerant of `confirm4f2a`/`Confirm-4f2a`/`confirm_4f2a`.

A session can hold **several pending codes at once** (cap 10, the oldest is
evicted beyond that): a new denial never erases a code already given, and an
armed token survives the denial of an unrelated command. A pending code
**never expires** — on the shared path (kimi/cursor) only the cap-10 eviction
removes it and arming keeps it listed (an expired token re-arms by retyping
the code); codex consumes it at arming, as before. The 5-minute TTL applies
to the ARMED token and the receipt only. Every prompt that is exactly
`CONFIRM <code>` gets a **visible acknowledgement** on the hosts with a
verified UserPromptSubmit channel — kimi (raw stdout) and codex
(`additionalContext` envelope): `[fuse-harness] CONFIRM xxxx accepted for:
<command> (valid 5 min)`, or `unknown — pending codes: …` listing the codes
still pending. An incidental code inside a longer prompt still arms, but
silently (byte-identical output). Cursor has a channel (`user_message`) but
through a separate envelope path — no emission yet; claude-code keeps its
native interactive `ask`; gemini-cli, cline and hermes have no verified
channel. On all of these, and on any prompt without a code, the output is
byte-identical.

Guardrails (`src/runtime/confirm/confirm-state.ts`, `confirm-subagent.ts`, `confirm-irreversible.ts`):

- **G0** — no token can be placed while a sub-agent is active for the session:
  a monotone `Math.max(prevSeenAt, now)` timestamp bumped by both
  SubagentStart and SubagentStop (never decremented, so a duplicated event
  from the multi-plugin fan-out can't desync it open), window tunable via
  `FUSE_CONFIRM_SUBAGENT_WINDOW_SEC` (default 300s). G0's primary protection
  is structural, not the window: a sub-agent never receives its own
  `UserPromptSubmit`, so it cannot place a token regardless of the window's
  value — the timestamp is a second belt for harnesses where that structural
  property isn't proven yet (Kimi).
- **G1** — a token is consumed on first successful use.
- **G2** — a token expires 5 minutes after it was placed.
- **G3** — the token is scoped to the action's full SHA-256 hash
  (`hashForAction`), never the 4-char display code (`displayCodeForAction`),
  which collides by design at 16 bits — it exists only so a human has
  something short to retype, never as the actual authorization boundary.
- **G4** — irreversible commands are never confirmable, regardless of a valid
  token: destructive git (`push --force`, `reset --hard`, `branch -D`,
  `clean -fd`, …, reusing `GIT_BLOCKED`) and any `rm -rf`/`-fr` variant.
- **G5** — an explicit refusal (`non`/`no`/`stop`/`cancel`/`annule`/…) in the
  next prompt drops the session's armed tokens. The pending denies SURVIVE on
  the shared path (kimi/cursor) — a code can simply be retyped later; codex
  clears its pending too (pre-existing per-path difference, kept).

**Scope, stated plainly**: this closes a recourse gap for an honest mistake or
a change of mind under a harness that can't show an interactive prompt — it is
**not** a security control against an adversarial agent. Any agent with
arbitrary shell access can write its own confirm token directly into the
session-state file it would need to pass and self-approve; that is true of
every stateful gate this harness keeps outside a sandbox, not specific to this
mechanism.

## Claude Code — `@fusengine/harness/adapters/claude`

| Export | Description |
|--------|-------------|
| `readClaudeInput()` | parse the Claude hook stdin payload |
| `denyResponse(event, reason)` | `hookSpecificOutput` deny JSON |
| `contextResponse(event, text)` | `additionalContext` injection JSON |
| `systemMessage(text)` / `informResponse(event, notice, context)` | user-visible pass notices (`systemMessage` channel), independent of the blocking decision |
| `guard(input)` | stateless-only: runs `evaluate()` and returns the native response, or null to allow |

```ts
import { readClaudeInput, guard } from "@fusengine/harness/adapters/claude";

const out = guard(await readClaudeInput());
if (out) { console.log(out); process.exit(0); }   // stdout carries the hookSpecificOutput deny/ask
```

## Kimi Code — manual wiring

`harness init` writes **no** kimi config: Moonshot AI's Kimi Code CLI reads
hooks only from the global `~/.kimi-code/config.toml`, which sits outside
`init`'s project-local model. Wire it by hand — append to `~/.kimi-code/config.toml`:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "npx -y @fusengine/harness hook kimi"
timeout = 30

[[hooks]]
event = "UserPromptSubmit"
command = "npx -y @fusengine/harness hook kimi"
timeout = 30
```

> **Emit only these four fields.** A `[[hooks]]` entry accepts exactly `event`
> (required), `matcher` (regex, optional), `command` (required) and `timeout`
> (int, 1-600s, default 30). **Any extra field makes Kimi fail to load the whole
> config** — do not add `id`, `name`, `type`, `enabled`, or anything else.

Scoped wiring is also available — the second argument selects the plugin scope
(`core` when omitted or explicit; unknown values warn on stderr and fall back
to `core`). Accepted plugin scopes are `solid`, `rules`, `carto`, `security`,
`changelog`, `aipilot`, `lessons`, `seo`, `memory`, `tailwindcss`, and `motion`
([`VALID_SCOPES`](../src/cli/scope.ts)). The `solid` scope
carries the PreToolUse file-size deny (`FUSE_SOLID_MAX_LINES`, default 100)
without the core-only APEX freshness gates:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Write|Edit"
command = "npx -y @fusengine/harness hook kimi solid"
timeout = 30
```

The `motion` scope carries owner-approved stills/draft render gates, sensitive
source-write checks, a critic sandbox, and render accounting — see
[motion.md](./motion.md) for the project contract, required lifecycle hooks,
and host limitations. Its PreToolUse wiring follows the same format:

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash|Write|Edit|Read|MultiEdit|NotebookEdit|CronCreate|CronDelete|ScheduleWakeup|RemoteTrigger|SendMessage"
command = "npx -y @fusengine/harness hook kimi motion"
timeout = 30
```

When distributing as a **Kimi plugin**, skip the global config entirely and
declare the hooks in `kimi.plugin.json` — Kimi injects `KIMI_PLUGIN_ROOT` and
`KIMI_CODE_HOME` into the hook process (the rules scope resolves both):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hooks": [
    { "event": "PreToolUse", "matcher": "Write|Edit", "command": "npx -y @fusengine/harness hook kimi solid", "timeout": 30 },
    { "event": "UserPromptSubmit", "command": "npx -y @fusengine/harness hook kimi rules", "timeout": 30 }
  ]
}
```

Notes:

- Tool names differ from Claude Code: `FetchURL` (not `WebFetch`), `Agent` (not
  `Task`), plus `Read/Write/Edit/Grep/Glob/ReadMediaFile/Bash/WebSearch/EnterPlanMode/ExitPlanMode/TodoList/AgentSwarm/AskUserQuestion/Skill/TaskList/TaskOutput/TaskStop/CronCreate/CronList/CronDelete`
  and `mcp__<server>__<tool>`. Write `matcher` regexes against those names.
- `Write`/`Edit` field names differ from Claude Code too: `Write` takes `path`
  + `content` (verified live against kimi-code v0.27.0, see below); `Edit`
  takes `path` + `old_string`/`new_string` (per `docs/en/reference/tools.md`,
  moonshotai/kimi-code — not yet live-tested). The path key is always `path`,
  never Claude's `file_path` (`src/adapters/kimi/index.ts`, `interfaces/types.ts`).
- The plan tool is `TodoList` (single tool, full-list re-emit per call) with a
  `pending | in_progress | done` status enum — never Claude's
  `TaskCreate`/`TaskUpdate`/`TaskList` triad (`src/policy/apex-target.ts`,
  `src/policy/apex-target-steps.ts`).
- Exit 0 = continue; exit 2 = stop, stderr is the reason; **anything else —
  other exit codes, timeout, crash — allows the call** (fail-open by design).
  The docs say stdout at exit 0 "may be appended" to the model's context —
  hedged, and `unverified — needs live test` (only deny and allow were
  exercised live), so treat `inform` delivery as best-effort.
- Only plugin manifests may declare hooks besides this file; there is no
  project-local hooks file.
- The dispatcher routes by payload, so every entry uses the same
  `hook kimi` command; the event comes from `hook_event_name` on stdin.
- **End-to-end wiring verified live against kimi-code v0.27.0** (`PreToolUse` /
  `Bash`): the deny envelope on stdout with **exit 0** stops the command — exit
  2 is not required — and Kimi re-injects `permissionDecisionReason` to the
  model, which cites it instead of retrying. Empty stdout at exit 0 lets the
  command run. The stdin payload carried `hook_event_name`, `session_id`,
  `cwd`, `tool_name`, `tool_input.command`, plus an **undocumented
  `tool_call_id`** the harness does not consume. A second, unrelated
  `PreToolUse` hook coexisted in the same config without error (the ordering
  and combination rule between two hooks on one event was not isolated).
  Events other than `PreToolUse`, and the `Edit` `tool_input` field names,
  remain `unverified — needs live test` — `Write`'s (`path`/`content`) has
  since been verified live (`src/adapters/kimi/index.ts:10-11`).
- After editing `~/.kimi-code/config.toml` by hand, run **`kimi doctor`** — the
  official validator; it prints `OK config.toml <path>` / `All checked config
  files are valid.` and exits non-zero on an invalid or missing file. Cheapest
  way to catch the extra-field trap above.

## Adding a harness

Two modes — pick by `detectMode()`:

### hook-mode (Cursor, Cline, Gemini, opencode)
Write `src/adapters/<harness>/index.ts`:

```ts
import { evaluate } from "../../policy/evaluate";

export function onBeforeEdit(payload: CursorPayload): CursorResponse {
  const r = evaluate({
    tool: "Write",
    filePath: payload.path,
    content: payload.newText,
  });
  return r.decision === "deny"
    ? { block: true, reason: r.message ?? "" }   // ← harness-native shape
    : { block: false };
}
```

Add a subpath in `package.json` `exports` and a `test/<harness>.test.ts`.

### cli-mode (Aider, Windsurf, OpenHands — no hook system)
These have no lifecycle hooks. Run the core from an external step (pre-commit,
lint, CI) via a CLI entry that reads staged files and calls `evaluate()`,
exiting non-zero on `deny`. *(The `bin/` CLI is not yet implemented — see the
roadmap in [CHANGELOG](../CHANGELOG.md).)*

## Status

## Wiring it in — `harness init` / `harness hook`

```sh
npx harness init          # detects the harness, writes its wiring file
npx harness init codex    # or target one explicitly
```

`init` writes the right config (`.claude/settings.json`, `.codex/hooks.json`,
`.cursor/hooks.json`, `.gemini/settings.json`, or `.clinerules/hooks/PreToolUse`)
pointing at `npx harness hook <id>` — the runtime dispatcher that reads the hook
payload on stdin, routes it to the adapter, and prints the native response.

## Status

| Adapter | Subpath | State |
|---------|---------|-------|
| Claude Code (hook) | `@fusengine/harness/adapters/claude` | ✅ |
| OpenAI Codex (hook) | `@fusengine/harness/adapters/codex` | ✅ (reuses Claude) |
| Cursor (hook) | `@fusengine/harness/adapters/cursor` | ✅ |
| Cline (hook) | `@fusengine/harness/adapters/cline` | ✅ |
| Gemini CLI (hook) | `@fusengine/harness/adapters/gemini` | ✅ |
| Hermes (hook) | `@fusengine/harness/adapters/hermes` | ✅ (reuses Claude stdin reader) |
| Kimi Code (hook) | `@fusengine/harness/adapters/kimi` | ✅ adapter — manual wiring only (no `harness init` runner) |
| CLI (`harness-check`) | `@fusengine/harness/cli` + bin | ✅ |

### cli-mode usage (Aider / Windsurf / OpenHands)

Install the package, then run `harness-check` as a pre-commit step:

```sh
# .husky/pre-commit  (or .git/hooks/pre-commit)
npx harness-check
```

It reads staged files, runs `evaluate()` on each, and exits non-zero (blocking the
commit) with the formatted prompt when a policy denies.

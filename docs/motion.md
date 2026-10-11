# motion — owner-approved render pipeline

The `motion` scope runs its own guards, not the core APEX pipeline. Invoke
`harness hook <host> motion`; a plugin using the installed package can call:

```sh
bun …/@fusengine/harness/dist/cli/bin.mjs hook claude-code motion
```

Replace `…` with the installed package's parent path and `claude-code` with
the target host. For Claude-compatible events, wire **PreToolUse**
(`Bash|Write|Edit|Read`), **UserPromptSubmit**, **SubagentStart**,
**SubagentStop**, and **PostToolUse** to the same command. Add `MultiEdit` and
`NotebookEdit` when exposed by the host, so covered write guards are reached.
For a plugin's `hooks.json`, the PreToolUse matcher must also include
**CronCreate, CronDelete, ScheduleWakeup, RemoteTrigger, SendMessage**:
otherwise those calls never reach the approval-forgery guard. This is wiring,
not a claim that every host exposes these tools or events. Other hosts use
their native events listed under [Hosts](#hosts), not Claude event names.

See [adapters.md](./adapters.md) for wiring conventions and
[`runtime/motion`](../src/runtime/motion/index.ts) for event dispatch.

## Project contract

The nearest ancestor with an existing `.motion` path is the project root;
the check does not require a directory, and the OS home itself never qualifies.
Without such an ancestor, project render gates and
source scanning are inactive (store/forgery guards still run).
Paths in `.motion/project.json` resolve relative to that root:

```json
{
  "render": "render.sh",
  "draft": "out/draft.mp4",
  "masters": ["out/master.mp4"],
  "sourceDir": "src",
  "reviewDir": ".motion/review"
}
```

| Field | Accepted value / default |
|-------|--------------------------|
| `render` | Script path or command string, e.g. `bun scripts/render.ts`; absent by default. Conventional `render.sh` invocations are also recognized. |
| `draft` | Draft artifact path; absent by default. |
| `masters` / `master` | `masters`: path array or one path; `master`: additional single path. Default: no declared masters. |
| `sourceDir` | Source-write scan directory; default `.` (project root). |
| `reviewDir` | Critic output directory; default `.motion/review`. |

The stills artifact is always `.motion/stills/contact.png`. Missing, invalid,
or unreadable project JSON uses the defaults, not a blanket refusal; a gate
requiring an undeclared/missing artifact refuses the corresponding render.
Source: [`project.ts`](../src/policy/motion/project.ts).

## G1 / G2 and owner approval

| Gate | Requested operation | Required approved artifact |
|------|---------------------|----------------------------|
| G1 | Declared render entry with `--stage draft` | `stills`: `.motion/stills/contact.png` |
| G2 | Recognized render entry with `--stage master`, or `ffmpeg` writing a declared master output | `draft`: the declared draft file |

No `--stage` means `stills` (ungated); an unknown or non-literal stage counts
as `master`. Missing/unreadable artifacts deny. Approvals bind to the full
**SHA-256** of artifact contents: changed artifacts are stale unless an
approval already exists for their current hash.

When the artifact exists but lacks approval, the refusal displays a
four-hex-character code. The owner types exactly:

```text
MOTION-APPROVE stills <code>
MOTION-APPROVE draft <code>
```

Use one line for the requested stage, replacing `<code>` with the displayed
code; matching is case-insensitive. There is **no native `ask`**. The grant
requires a pending request with the same session, stage, code, and current
artifact hash. An explicit refusal cancels that session's pending requests,
not previously granted approvals. Stored approvals are project-scoped.

Human-origin checks reject payloads carrying `agent_id`/`agent_type` and
automated envelope markers (`<teammate-message`, `<task-notification`,
`<cross-session-message`, `<channel`, `<system-reminder`). A native prompt event
alone is not proof of human origin; these are payload/content checks, not
cryptographic authentication. Sources: [`gates.ts`](../src/policy/motion/gates.ts),
[`approve-prompt.ts`](../src/policy/motion/approve-prompt.ts),
[`approvals.ts`](../src/policy/motion/approvals.ts).

## Store and anti-forgery

Trusted state lives outside the repository:
`~/.fuse-harness/motion/<hash(root)>/{approvals,pending,budget}.json`, where
`hash(root)` is the first 16 hex characters of SHA-256 of the canonical root.
Critic flags live under `~/.fuse-harness/motion/sessions/<session>.json`.
`.motion/approvals.log` is only a mirror, never an approval source.

Approval records are signed with HMAC-SHA256. The per-project key lives in
`~/.fuse-harness/motion-keys/<hash(root)>.key` (mode `0600`, created
atomically); unsigned or mis-signed records are ignored. The harness keeps its
own registry under `~/.fuse-harness/motion/state/` (`<hash>.json` state
witnesses and `<hash>.grants.json`, the grants it wrote itself). A key or an
approval the registry never recorded — for example one planted before the
harness first observed the project — is not trusted: the owner re-approves.

Write tools and detected Bash writes/destructive operations targeting the
store or the key directory are denied. The shared path guard protects
`~/.fuse-harness/motion/` and `~/.fuse-harness/motion-keys/` for **every**
hook scope, not only `motion`; reads (`cat`, `ls`, `jq`) stay allowed. Bash
commands containing `MOTION-APPROVE`, and scheduling or messaging tool inputs
carrying that phrase, are denied to prevent replay through automated prompts.
Sources: [`store.ts`](../src/policy/motion/store.ts),
[`auth-key.ts`](../src/policy/motion/auth-key.ts),
[`auth-approval.ts`](../src/policy/motion/auth-approval.ts),
[`state-witness.ts`](../src/policy/motion/state-witness.ts),
[`self-approval.ts`](../src/policy/motion/self-approval.ts),
[`forgery.ts`](../src/policy/motion/forgery.ts).

## State verification

Command-text guards are the first line. The second line does not depend on
the command's shape: after every tool call (PostToolUse, tool failure) and at
Stop/SubagentStop, the harness compares the protected artifacts with the
approved state.

- **Draft/master** are legitimate only when produced by an authorized render
  in the same tool call (the harness records the resulting hash at that
  call's PostToolUse). Any other appearance or change is moved to
  `.motion/quarantine/<timestamp>-<name>` — **moved, never deleted** — with a
  native message; the owner can restore it by hand. While an authorized render
  is still running, other hooks leave its partial output in place.
- **Key, store or `.motion/project.json`** changed outside the harness's own
  writes ⇒ every approval of the project is invalidated until the owner
  re-approves (fail-closed). The harness's own writes never self-invalidate.
- **First observation**: an existing draft/master is left in place but never
  counts as approved (no G2 on it; the next master needs the normal circuit),
  and the agent is told so.
- If the OS refuses the move, the file stays, approvals are invalidated and
  the message reads `QUARANTINE FAILED`.

In a motion project, Bash commands that detach a process (`nohup`, `setsid`,
`disown`, trailing `&`, `at`, `batch`, `launchctl`, including inside `case`
or `time`) are denied, so a write cannot be deferred past the check.
Sources: [`state.ts`](../src/policy/motion/state.ts),
[`state-files.ts`](../src/policy/motion/state-files.ts),
[`guard-detach.ts`](../src/policy/motion/guard-detach.ts),
[`runtime/motion/post.ts`](../src/runtime/motion/post.ts).

## Sensitive source data

Keep `~/.fuse-harness/motion/banned.txt` **outside every Git repository**.
It contains one banned term per line; blank lines and `#` comments are
ignored. Matching is case-insensitive with NFC normalization; an absent or
unreadable list supplies no terms. Currency amounts (`$`, `€`, `£`,
`USD`, `EUR`, `GBP`) are also checked independently of the list.

Write/Edit/MultiEdit content under `sourceDir` is scanned in full (no size
cut-off), not the on-disk file or arbitrary Bash-generated content. Shell
positional parameters (`$1`, `${2}`, `awk '{print $1}'`) are not treated as
currency amounts, nor are field references (`$3`, `$NF`, `${2}`) in the code
of a closed, single-quoted multi-line awk/gawk/mawk program in shell command
position; awk string literals and comments are still scanned. Detected values deny the write
and are masked in the report: one-/two-character values are fully masked;
longer ones retain only their first character.
Source: [`sensitive.ts`](../src/policy/motion/sensitive.ts).

## Critic sandbox and budget

SubagentStart tracks `motion-critic` (including plugin-prefixed names);
SubagentStop clears its flag by agent id. Active critics cannot use
Write/Edit/MultiEdit/NotebookEdit. Read permits image/video files or paths
inside `reviewDir`; Bash permits only `ffprobe`, `ffmpeg`, `ls`, and `stat`.
ffmpeg outputs and side-file targets must stay inside `reviewDir`; indirect
output muxers and cwd-writing flags are blocked. Shell redirects must stay
there or target `/dev/null`. This allows review-pack generation, not source
editing. If tool events lack an agent id while a critic is active, the
sandbox applies conservatively to those events.
Source: [`critic.ts`](../src/policy/motion/critic.ts).

PreToolUse reserves a render and PostToolUse counts it once and accumulates
wall time per `stills`, `draft`, and `master` (including ffmpeg master
writes); a failed tool call releases the reservation without counting.
Correlation uses each host's native call id (`tool_use_id`, Kimi
`tool_call_id`), scoped by session; hosts without one (gemini-cli, cline,
hermes, cursor without id) use a single-flight identity derived from session,
working directory and command. A host with a native id may deliver the same
PreToolUse twice (same `tool_use_id`): while the reservation is fresh and the
recorded receipt matches session, stage and command, the second delivery is
idempotent — no new reservation, budget and state byte-identical, same "Motion
render" note; any mismatch (or a `noid:` id) keeps the existing refusals.
A corrupt budget file is never repaired: renders
stay denied until the owner fixes it. There is no wall
time cap. `FUSE_MOTION_MAX_MASTER_RENDERS` sets the master-render count cap:
a positive integer denies further masters once reached; unset, empty,
invalid, fractional, or non-positive values mean no cap.
In-flight reservations expire: an entry older than
`FUSE_MOTION_RENDER_TTL_MS` (default 1800000 ms = 30 min; same parsing rules
as the master cap) no longer blocks a concurrent render of its stage nor
counts against the master cap. It is not forgotten: the reservation moves to
a retained `expired` map, so a late completion still counts the render
(`renders`, `wallMs`) and attributes its outputs exactly as if it had not
expired; entries are dropped only 24 h after their start, which bounds
reservations whose tool never ran.
The main turn's Stop releases **no reservation, on any host**: a sub-agent's
PreToolUse may carry no `agent_id`, so its reservations are indistinguishable
from the main turn's — releasing on Stop could free a render of a
still-running background sub-agent. A main-turn leak falls by the TTL alone.
On **claude-code only**, a SubagentStop with a non-empty `agent_id` releases
that sub-agent's FRESH reservations (only entries written with the exact same
`agent_id` can match, so this is safe on every host version); a render still
running in another agent keeps blocking, and expired reservations — native-id
or `noid:` — are never released by a stop event and stay settleable. Codex gets **no
release**: an `exec_command` returns control to the model while the process
keeps running (no PostToolUse until it finishes, and the process can outlive
the turn), so a sub-agent can emit SubagentStop while its render is still
active — releasing there would admit a concurrent render and lose the late
completion. Every other host
(kimi, cursor, gemini-cli, cline, hermes) gets **no release** on
Stop/SubagentStop at all, because a sub-agent's end cannot be
told apart from the main turn's there (kimi fires a marker-free Stop with the
shared session id); the TTL and the 24 h horizon are the only backstop.
The release is best-effort — a corrupt or busy
budget is left untouched (the TTL is the backstop) and never changes the
Stop/SubagentStop output, which stays identical to HEAD on every host.
Entries written before 0.1.104 carry no session id and expire by TTL only.
Source: [`budget.ts`](../src/policy/motion/budget.ts).

## Failures and known limits

- Missing/corrupt approval state means no approval: gated renders deny.
  Failure to save a pending request cannot turn that denial into an allow;
  owner approval cannot succeed without a matching pending request.
- Other internal exceptions **fail open**, returning empty stdout / exit 0
  and a `harness motion: …` diagnostic on stderr.
- **Same-UID limit**: this is not OS isolation. An agent running as the same
  user that rewrites every witness at once (key, store **and** the harness
  registry) through code the text guards do not recognize can still forge
  state. State verification catches partial tampering, not a complete rewrite.
- Command-text guards (render classification, detach guard) are not
  exhaustive; state verification is the backstop, applied at the next hook.
  The foreground operators `|&`, `;&` and `;;&` are not treated as detaching.
- A render cancelled by the host without any terminal event (no PostToolUse,
  no failure) keeps its reservation until it expires: in-flight entries older
  than `FUSE_MOTION_RENDER_TTL_MS` (default 30 min) stop blocking and counting
  at the next admission check. The main turn's Stop never releases a
  reservation; on claude-code a SubagentStop with a non-empty
  `agent_id` releases that sub-agent's own fresh reservations (best-effort) —
  a SubagentStop without a usable agent id releases nothing. Other hosts
  (kimi, codex, cursor, gemini-cli, cline, hermes) never release on
  Stop/SubagentStop. A render genuinely running
  longer than the TTL no longer blocks a concurrent admission, but its
  completion keeps full budget and output attribution as long as it settles
  within 24 h of its start; past that horizon the reservation is forgotten
  and its outputs are treated as unapproved.
- On hosts without a native call id (gemini-cli, cline, hermes, cursor without
  id), the render id derives from session + command, so relaunching the
  identical command in the same session reproduces the same id: while that
  id's expired reservation is retained, the re-run stays refused ("Motion
  render identity") until the late completion settles it or the 24 h horizon
  forgets it — these hosts get no Stop release, so the horizon is the last
  way out.
- The TTL is a deliberate trade-off: a render genuinely running longer than
  `FUSE_MOTION_RENDER_TTL_MS` no longer blocks a concurrent admission, so the
  master cap can be exceeded in that case (the late finisher still counts
  against the budget once it settles). Increase `FUSE_MOTION_RENDER_TTL_MS`
  if your renders are long.
- Changes made by another session that never observes the project are caught
  only at the next hook of a session that does.
- G2 hashes the draft, not the sources it was rendered from.
- `pending.json` is readable by the agent (it holds codes the owner types; it
  cannot grant anything by itself).
- Cursor post-tool events cannot carry a message: quarantine/invalidation
  still happen, the agent is not told.

Sources: [`gates.ts`](../src/policy/motion/gates.ts),
[`runtime/motion/index.ts`](../src/runtime/motion/index.ts),
[`command.ts`](../src/policy/motion/command.ts).

## Hosts

The owner's 2026-10-08 measurements used `dist/cli/bin.mjs` with native
payloads, not live host applications. They cover only these four cases:
A = draft render denied without stills approval (refusal shows `MOTION-APPROVE stills <code>`);
B = store write denied; C = approval prompt recorded; D = render allowed in a new session after approval.

| Host | Tested native events/tools | A | B | C | D | Deny response |
|------|----------------------------|---|---|---|---|---------------|
| `claude-code` | `PreToolUse` / `Bash`, `Write`; `UserPromptSubmit` | OK | OK | OK | OK | `hookSpecificOutput.permissionDecision: "deny"` |
| `codex` | `PreToolUse` / `Bash`, `exec_command`, `apply_patch`; `UserPromptSubmit` | OK | OK (`apply_patch` Add File) | OK | OK | `hookSpecificOutput.permissionDecision: "deny"` |
| `cursor` | `beforeShellExecution`; `preToolUse` / `Shell`, `Write`; `beforeSubmitPrompt` | OK | OK | OK | OK | `{"permission":"deny","user_message":…}` |
| `kimi` | `PreToolUse` / `Bash`, `Write` (`path`); `UserPromptSubmit` | OK | OK | OK | OK | `hookSpecificOutput.permissionDecision: "deny"`; prompt notice: raw text |
| `gemini-cli` | `BeforeTool` / `run_shell_command`, `write_file`; `BeforeAgent` | OK | OK | OK | OK | `{"decision":"deny","reason":…}` |
| `cline` | `PreToolUse` / `execute_command`, `write_to_file`; `UserPromptSubmit` (`hookName`, `userPromptSubmit.prompt`) | OK | OK | OK | OK | `{"cancel":true,"errorMessage":…}` |
| `hermes` | `pre_tool_call` / `terminal`, `write_file`; `pre_llm_call` | OK | OK | OK | OK | `{"decision":"block","reason":…}` |
| `opencode`, `windsurf`, `copilot`, `aider`, `kiro`, `goose`, `amp` | Not tested | — | — | — | — | Not measured |

Cursor `afterFileEdit` is post-write and cannot block: the measured response
is `{}`; motion blocks writes through `preToolUse`. G2, critic lifecycle and
budget parity are not established by A–D. gemini-cli `AfterAgent` fires both
for the main agent and for subagents (`agent_name` is set only for a
subagent, and only on versions carrying PR #25033); it releases no
reservation at all — no host releases anything on the main turn's Stop, and
the SubagentStop release is restricted to claude-code.
Native routing source: [`host.ts`](../src/runtime/motion/host.ts).
Prompt/post-tool notices use native response adapters. Kimi's `tool_call_id`
is used as its native call id. Sources: [`prompt.ts`](../src/runtime/motion/prompt.ts),
[`post.ts`](../src/runtime/motion/post.ts),
[`normalize.ts`](../src/runtime/normalize.ts),
[`reply.ts`](../src/runtime/motion/reply.ts).

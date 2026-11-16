# PRD — task/agent ownership coordination

**Opt-in, off by default.** When a lead splits one task across several
sub-agents, PRD gives every sub-agent a JSON file it — and only it — is
allowed to write, so two agents can never clobber each other's report. A
lead reads `harness prd status` to see who has finished what, and
`harness prd validate` promotes a task once every agent's report matches
what it was assigned. With the flag off, or with no router file on disk,
the module reads nothing, writes nothing, and every hook output is
byte-identical to a harness without PRD at all.

## Turn it on

Set `FUSE_PRD` to the exact string `1` in the harness's own `.env` —
`~/.claude/.env`, `~/.codex/.env`, `~/.cursor/.env`, `~/.kimi-code/.env` —
or in `<project>/.env`. Then bootstrap the router with
`harness prd init [--task <id>]` (see [CLI](#cli)) — the lead cannot `Write`
`apex/prd.json` itself (`protectedPathGuard` blocks it), so the CLI creates
it. Once it exists, the coordinator adds tasks to it with `Write`/`Edit`.

| State | Router file | Result |
|---|---|---|
| `FUSE_PRD` unset | any | Inert. Zero reads, zero writes, unchanged stdout. |
| `FUSE_PRD=1` | missing | Still inert — activation needs **both** the flag and the router. Same output as the flag being unset. |
| `FUSE_PRD=1` | present | Active: ownership checks, the Bash-under-`prd/` deny, `SubagentStart` context, block-once on `SubagentStop`/`Stop`. |

## File layout

Everything lives under `<project>/<homeSeg>/apex/` (`homeSeg` is `.claude`,
`.codex`, `.cursor`, `.kimi-code` — whichever the running harness resolves
to). One writer per file, by construction:

| File | Written by |
|---|---|
| `apex/prd.json` (the router) | created by `harness prd init`; tasks added by the coordinator |
| `apex/prd/<task>-prd.json` | the coordinator only |
| `apex/prd/agents/<agent>-prd.json` | the one agent that claims that slot — nobody else |
| `apex/prd/docs/<task>.md` | the coordinator, free-form notes |

**Agent names are plugin-namespaced.** A plugin agent's `agent_type` carries
its plugin prefix, e.g. `fuse-typescript:typescript-expert`. Task-PRD keys
and report names are that exact string, so the report path contains a colon:
`<project>/<host-home>/apex/prd/agents/fuse-typescript:typescript-expert-prd.json`
(always this absolute form, e.g. `<project>/.codex/apex/prd/agents/…` on Codex —
never `<project>/prd/agents/…`, see the outside-tree deny below). A second agent of the
same type is `fuse-typescript:typescript-expert-2`, and so on. (A built-in,
non-plugin agent has a bare `agent_type` such as `general-purpose`, and its
keys/files are bare too: `general-purpose-prd.json`.)

## Full cycle: the `auth-refactor` example

The router and task-PRD shapes below follow `test/fixtures/prd/`
(`router.json`, `prd/auth-refactor-prd.json`); those fixtures use bare
agent names (`backend-expert`, a non-plugin custom agent), whereas this
walkthrough uses the plugin-namespaced form real sessions produce.
The command outputs are the real CLI formats.

1. Bootstrap the router (needs `FUSE_PRD=1`; the lead cannot `Write` this
   path):

   ```
   $ FUSE_PRD=1 harness prd init --id claude-code --task auth-refactor --root <project>
   prd init: created <project>/.claude/apex/prd.json with task "auth-refactor"
   prd init: agent reports go in <project>/.claude/apex/prd/agents/<agent>-prd.json (absolute path — never <project>/prd/agents/)
   ```

   `--id` is the harness home (`claude-code` → `.claude`, `codex` →
   `.codex`, `cursor` → `.cursor`, `kimi` → `.kimi-code`; map: `HOME_DIR`,
   `src/config/dotenv.ts`). It may be omitted only when exactly one harness
   home directory exists under `--root`; with none, or several (`.claude` +
   `.kimi-code`…), `init` exits `2` with `... — pass --id <harness>`
   (`src/cli/prd/resolve.ts`).

   The created `.claude/apex/prd.json`:

   ```json
   { "auth-refactor": { "prd": "prd/auth-refactor-prd.json", "status": "assigned" } }
   ```

2. The coordinator writes `.claude/apex/prd/auth-refactor-prd.json`,
   naming two slots and what each owns:

   ```json
   {
     "fuse-typescript:typescript-expert":   { "files": ["src/auth/login.ts"],   "sub-tasks": { "jwt-validation": { "status": "assigned" } } },
     "fuse-typescript:typescript-expert-2": { "files": ["src/auth/session.ts"], "sub-tasks": { "session-store":  { "status": "assigned" } } }
   }
   ```

3. Both slots belong to the same base `agent_type`
   (`fuse-typescript:typescript-expert`), so a starting sub-agent's
   `SubagentStart` context can't yet tell which of the two it is. It gets
   **both** slices, prefixed with the exact disambiguation header from
   `agentSlices`/`renderAgentSliceMarkdown` (`prd-context.ts`):

   ```
   Several assignments match your agent type. You are ONE of: fuse-typescript:typescript-expert, fuse-typescript:typescript-expert-2. The first report you write binds your name; write only that report.

   ## PRD assignment — task auth-refactor
   Your files: src/auth/login.ts
   Your sub-tasks: jwt-validation
   Report to <project>/.claude/apex/prd/agents/fuse-typescript:typescript-expert-prd.json when done (absolute path — never <project>/prd/agents/).

   ## PRD assignment — task auth-refactor
   Your files: src/auth/session.ts
   Your sub-tasks: session-store
   Report to <project>/.claude/apex/prd/agents/fuse-typescript:typescript-expert-2-prd.json when done (absolute path — never <project>/prd/agents/).
   ```

   A slot is **claimed by writing its report** (`resolveClaim`,
   `src/policy/prd/prd-claim.ts`), in any order — the slice order above is
   not an assignment. The first write binds the writer's `agent_id` to that
   slot for the session, and the claim is one slot per agent. The other
   sub-agent is then left with the remaining open slot(s).

4. The agent that claimed `fuse-typescript:typescript-expert` finishes and
   writes **only** `.claude/apex/prd/agents/fuse-typescript:typescript-expert-prd.json`:

   ```json
   { "auth-refactor": { "jwt-validation": { "status": "done", "modified": ["src/auth/login.ts"], "unchanged": [] } } }
   ```

5. That same agent then tries to write
   `fuse-typescript:typescript-expert-2-prd.json` instead — denied (exact
   reason string from `prd-claim.ts`, prefixed with the offending path by
   `prd-pre-gate.ts`). The prefix is the file's **full canonical absolute
   path** (`canonicalFilePath()`), never a project-relative one — yours
   will differ, but it is always absolute, never a bare `.claude/apex/...`
   fragment:

   ```
   [BLOCKED] PRD ownership
   <project>/.claude/apex/prd/agents/fuse-typescript:typescript-expert-2-prd.json: you already own slot "fuse-typescript:typescript-expert" — one slot per agent, "fuse-typescript:typescript-expert-2" is not yours to write
   Next: 1. Write only the files/report this agent owns per its PRD slice
         2. Run `harness prd status` to see the current assignment
   ```

6. The coordinator checks progress — no flag needed for `status`. This is
   the output of `harness prd status --root <project>` at this point
   (`fuse-typescript:typescript-expert-2` hasn't reported yet):

   ```
   $ harness prd status --root <project>
   Task           Router status  Agents  Sub-tasks done/total  Violations
   auth-refactor  assigned       2       1/2                   0
   ```

7. The coordinator tries to validate too early, **without** `FUSE_PRD=1` —
   denied because `validate` writes:

   ```
   $ harness prd validate auth-refactor --root <project>
   prd validate requires FUSE_PRD=1 in .claude/.env or the project .env
   ```
   (exit code `1`)

8. With the flag set, `validate` now catches the real gap —
   `fuse-typescript:typescript-expert-2` still has no report:

   ```
   $ FUSE_PRD=1 harness prd validate auth-refactor --root <project>
   prd validate: 1 violation(s)
     - auth-refactor/fuse-typescript:typescript-expert-2/session-store: no "done" report from "fuse-typescript:typescript-expert-2" for sub-task "session-store"
   ```
   (exit code `1`)

9. Once the second agent claims `fuse-typescript:typescript-expert-2` and
   writes its own
   `.claude/apex/prd/agents/fuse-typescript:typescript-expert-2-prd.json` with a `"done"`
   entry for `session-store`, the same command succeeds silently:

   ```
   $ FUSE_PRD=1 harness prd validate auth-refactor --root <project>
   ```
   (exit code `0`, no output — both agents' sub-tasks are now `validated`
   and the router entry is promoted to `validated`)

10. `status` now confirms it:

    ```
    $ harness prd status --root <project>
    Task           Router status  Agents  Sub-tasks done/total  Violations
    auth-refactor  validated      2       2/2                   0
    ```

11. The coordinator compacts the finished task PRD (`compact` also
    requires the flag, since it writes):

    ```
    $ FUSE_PRD=1 harness prd compact auth-refactor --root <project>
    compacted: fuse-typescript:typescript-expert, fuse-typescript:typescript-expert-2
    ```
    (exit code `0`) — each agent entry in
    `.claude/apex/prd/auth-refactor-prd.json` is now
    `{ "status": "validated", "files": [...], "validated-at": "2026-09-02T21:04:10.223Z" }`.

    On Codex, this step is never a surprise: the coordinator's Stop right
    after step 10 already carried the compact hint below, naming
    `auth-refactor` and the exact command to run.

## What the guards do

Six enforcement points, all inert unless PRD is active — the last one is a
pure information, never a block:

| Guard | When | Who it applies to | What the agent sees |
|---|---|---|---|
| Write/Edit ownership (`prd-pre-gate.ts`) | A `Write`/`Edit`/`apply_patch` targets the router, a task PRD, or `prd/agents/*.json` | claude-code / codex: enforced by identity. cursor / kimi: consultative — never blocked here | A `[BLOCKED] PRD ownership` prompt: `<path>: <reason>`, where `<reason>` is one of `"router is coordinator-only"`, `"task PRD is coordinator-only"`, `"docs is coordinator-only"`, `"agent report is not the coordinator's to write"`, `"unidentifiable agent_type — cannot verify ownership"`, or one of the claim reasons in [Claiming a slot](#claiming-a-slot-closed-slots-and-resume) |
| Bash-under-`prd/` deny (`prd-pre-gate.ts`) | A Bash `>`/`>>` redirect targeting `apex/prd/` (`shellOutputRedirects`), **or** one of 6 non-redirect write verbs whose write-target argument resolves there (`extraBashWriteTargets`, `prd-bash-targets.ts`): `cp`/`mv`/`install` (last positional arg), `tee` (every positional arg), `sed -i`/`perl -i` (last positional arg, in-place only), `dd of=` (the `of=` operand). Verified live: `cp <src> <prd-path>` and `dd if=<src> of=<prd-path>` both deny; `touch <prd-path>` — a write verb outside this list — is **not** caught here (falls through to the ordinary gate chain, which has no `.claude/apex/` case for `touch` either, so it currently allows). Best-effort static scanner, not a shell — see the module's own header for the `getopt_long` PERMUTE-mode edge case it does not track. | Everyone, coordinator included | `"PRD files must be written via Write/Edit/apply_patch, never Bash."` |
| Outside-tree report deny (`prd-outside-report.ts`, runs first in `prd-pre-gate.ts`) | A write target (Write/Edit/MultiEdit path, `apply_patch` Add/Update file, Bash redirect or write-verb target) named `<x>-prd.json` whose parent directory is **exactly** `<project>/prd/agents` or `<payload cwd>/prd/agents` (symlink-aware) — the shape an executor produces when it follows the relative text `prd/agents/…`. A path rule, not identity; runs even when the router is broken. Relative targets resolve against the payload `cwd`. Never touched: deletes (`*** Delete File:`, so leftovers can be cleaned up), other lookalike trees (`test/fixtures/prd/prd/agents/…`, `docs/prd/agents/…`, backups elsewhere), another host's tree (`<project>/.codex/apex/prd/agents/…`), and files without the `-prd.json` suffix. | Everyone, every host (cursor/kimi included) | `<file> is outside <agents dir> — write your PRD report to <absolute report path>` |
| PostToolUse cross-check (`prd-post-check.ts`) | Right after the router or a task PRD is written | Silent — no immediate message | Nothing at the time; a mismatch between what a task PRD assigned and what an agent actually reported is recorded, and can later trigger the lead's `Stop` block below |
| `SubagentStart` context (`prd-subagent-context.ts`) | A sub-agent's session starts | That sub-agent only | Its own file/sub-task slice injected as context (the `## PRD assignment` block in the example above) |
| `SubagentStop` block-once (`prd-subagent-stop.ts`) | A sub-agent tries to stop with an undone sub-task | That sub-agent, once | `"PRD sub-task(s) not done for <agent> on task \"<task>\": <sub1, sub2, ...>. Finish the work (or ask the coordinator to reassign) before stopping."` — never fires on Cursor (identity is unlinkable there, see Known limitations) |
| Lead `Stop` block-once (`prd-stop-gate.ts`) | The lead tries to stop with an unresolved cross-check violation | The gate itself is target-agnostic. **claude-code: wired** — the marketplace Stop hook list has a second, flag-less entry (`hook claude-code core`, sound muted) that reads stdin and reaches the gate (`claude-plugins/plugins/core-guards/hooks/hooks.json:113-120`; `src/runtime/lifecycle/dispatch.ts:89-94`). Its first Stop entry (`--sound stop`) only plays the sound and exits before stdin, which is why it never reaches the gate. Codex and Kimi wiring: **unverified** here (their plugin repos are not in this checkout). Never fires on Cursor (`stop` isn't gated there — design doc §5). See Known limitations. | `"PRD cross-check found unresolved violation(s): a task/sub-task is marked validated without a matching done report. Run \`harness prd status\` for details."` |
| Lead `Stop` compact hint (`prd-stop-gate.ts`) | The lead's Stop fires with **no** violation and at least one task is fully validated (every agent, every sub-task) but not yet compacted | Target-agnostic in code — it mirrors the SAME per-target form choice as the block-once row above, with no id allowlist, and is reached by the same targets/wiring as the block-once gate above (claude-code: wired per the row above; Codex/Kimi: unverified). See Known limitations. | `hookSpecificOutput.additionalContext`: `"PRD task \"<task>\" is fully validated and ready to compact. Run \`harness prd compact <task>\`."` (or, with several tasks ready at once, `"PRD tasks fully validated and ready to compact: <t1>, <t2>. Run \`harness prd compact <task>\` for each."`) |

### Claiming a slot, closed slots and resume

The rule (`resolveClaim`, `src/policy/prd/prd-claim.ts`; disk check
`isSlotClosed`, `prd-crosscheck.ts`):

- A slot is claimed by **writing its report**, in any order, first come;
  one slot per agent. The binding lives in the per-session track.
- A slot whose sub-tasks are all `done` (in its report) or `validated`, or
  that is compacted, on disk is **closed**: a new agent can never rewrite it.
- A partial or absent slot is **claimable by any same-type agent**. Resume
  after an interruption: relaunch same-type agents in a fresh session —
  they take the still-open slots.
- A slot stays bound to its agent for the rest of the lead session, even
  after that agent stopped. Relaunching an agent for an unfinished slot in
  the **same** lead session is denied with `slot "<target>" is already owned
  by another agent of this session` (`prd-claim.ts`). Resume must be done in
  a **fresh lead session**.
- A **first claim** whose content names none of the slot's own sub-tasks is
  denied (it looks like another agent's report; `prd-report-claim.ts`).
  Content that cannot be derived with certainty is never judged.
- The claim is committed under a dedicated claim lock
  (`prd-claim-bind.ts`); if the lock is busy, retry the write.

Deny messages (each is the `<reason>` shown in the `[BLOCKED] PRD
ownership` prompt, prefixed with `<absolute path>: `), quoted from source:

| Case | Reason | Source |
|---|---|---|
| Slot not declared for your type | `"<target>" is not a slot of your agent_type "<agent_type>" (your slots: <a, b>)` (`none` when empty) | `prd-claim.ts` |
| Already bound to another slot | `you already own slot "<mine>" — one slot per agent, "<target>" is not yours to write` | `prd-claim.ts` |
| Slot bound to another agent | `slot "<target>" is already owned by another agent of this session` | `prd-claim.ts` |
| Slot closed on disk | `slot "<target>" is already reported complete — a new agent cannot rewrite it; claim a slot that is still open` | `prd-claim.ts` |
| First claim, foreign content | `this report names <task>/<sub>, ..., none of which is a sub-task assigned to slot "<slot>" — it looks like another agent's report` | `prd-report-claim.ts` |
| Race lost at commit | `you already own slot "<held>" — one slot per agent` / `slot "<name>" was just claimed by another agent` | `prd-claim-bind.ts` |
| Claim lock busy | `the claim lock is busy — retry this write` | `prd-claim-bind.ts` |
| Track write failed | `the claim could not be recorded (session track busy) — retry this write` | `prd-claim-bind.ts` |

A malformed (unparseable JSON) router with `FUSE_PRD=1` active is its own
case: every in-scope PRD write is denied with
`"PRD router is malformed JSON — fix apex/prd.json or unset FUSE_PRD."`,
while every other file in the same session is unaffected.

One edge case worth calling out: an `agent_id` with **no** `agent_type` at
all (not observed live, but a defined case) is always treated as a
sub-agent and denied outright on an agent-report write — reason
`"unidentifiable agent_type — cannot verify ownership"` — rather than
falling back to consultative mode. Presence of `agent_id` proves the
harness *can* send identity, so a missing `agent_type` is failed closed,
unlike Cursor/Kimi's structural absence of both fields.

## Capability matrix

Per capability, not per adapter — coverage splits unevenly across targets:

| Capability | claude-code | codex | cursor | kimi | cline / gemini-cli / hermes |
|---|---|---|---|---|---|
| Write ownership block | full | full | consultative only (never blocks) | consultative only (never blocks) | full, if the consumer wires `PreToolUse` |
| Bash-under-`prd/` deny | yes | yes | yes | yes | yes |
| `SubagentStart` slice injection | yes | yes | **no** — the slice IS built (identical to claude-code's), but `adapters/cursor/respond.ts`'s `toCursorLifecycleResponse` collapses any non-denied `subagentStart` to bare `{"permission":"allow"}`, dropping it; measured byte-identical output with a matching PRD assignment, with no router at all, and with `FUSE_PRD` unset | delivered, ignored (observation-only) | gemini-cli: yes, delivered — routed through `respond()`'s native "inform" shape, then re-wrapped by `joinContextResponses` into the shared Claude-style `hookSpecificOutput.hookEventName/additionalContext` envelope plus a `[NOTE]` title line (not gemini-cli's own minimal shape, but the text arrives). hermes: yes, delivered — same Claude-style `contextResponse` as claude-code; Hermes's own documented non-blocking shape is `{context}`, not `hookSpecificOutput`, so whether a real Hermes client reads it is unverified. cline: yes, delivered in its own native `{contextModification}` shape — `joinContextResponses` keeps whichever envelope its parts came from instead of assuming the Claude one (measured 476 bytes where an earlier build emitted none; the other targets' envelopes are unchanged — only the report line inside the slice text now carries the absolute path, so byte counts differ with the project path and are no longer pinned here) |
| `SubagentStop` block-once | yes | yes | delivered, response ignored | delivered, response ignored | yes — each in its OWN native block shape via `respond()`: gemini-cli `{"decision":"deny","reason"}`, cline `{"cancel":true,"errorMessage"}`, hermes `{"decision":"block","reason"}` (via `blockResponse`, which happens to match Hermes's own documented block contract). Block-once verified: 1st call blocks, an identical replay is silent (empty stdout) on all three, under both the default journal-based session track and legacy `FUSE_TRACK_JOURNAL=0` |
| Lead `Stop` block-once | yes — wired via the second, flag-less Stop entry (`hooks.json:113-120`); the first entry (`--sound stop`) exits before stdin and never reaches it | yes (unverified against the Codex plugin repo here) | not applicable (`stop` isn't gated on Cursor today) | unverified — Kimi's plugin wiring is not in this checkout | yes — same per-adapter native shapes and block-once behavior as `SubagentStop` above (gemini-cli/cline/hermes), verified under both tracking modes |

Cursor and Kimi never hard-block on file ownership: the harness cannot
correlate a sub-agent's write back to its own identity on either target
(see [Known limitations](#known-limitations)), so both stay consultative
and rely on the after-the-fact cross-check instead. The one exception is
the outside-tree report path rule (table above): it depends on the path,
not on identity, so on Cursor and Kimi it is a hard deny, like everywhere
else.

## CLI

```
harness prd init [--task <id>] [--id <harness>] [--root <dir>]
harness prd status [--json] [--id <id>] [--root <path>]
harness prd validate <task> [agent] [--id <id>] [--root <path>]
harness prd compact <task> [--id <id>] [--root <path>]
```

Any other sub-command exits with
`harness prd: unknown sub-command "<sub>" (expected status|validate|compact|init)`.

`--root` defaults to `cwd`. `--id` picks the harness (and therefore the
`homeSeg` — `.claude`, `.codex`, …) explicitly; without it, the CLI
auto-detects the *sole* `homeSeg` under `--root` that has an
`apex/prd.json` — zero or more than one match is a usage error, not a guess.
`init` has no router yet, so without `--id` it uses the *sole* existing
home directory under `--root` (`<root>/.claude`, …); none or several is
exit `2` with `... — pass --id <harness>`.

- **`init`** — creates the router, **requires `FUSE_PRD=1`**. Creation is
  atomic and never clobbers (temp file + `link`, which fails on `EEXIST`):
  an existing router is never rewritten. `--task <id>` seeds the router
  with `{ "<id>": { "prd": "prd/<id>-prd.json", "status": "assigned" } }`;
  `<id>` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, and `--task=foo`
  (equals form) is rejected — pass `--task foo`. Without `--task` the router
  is `{}`. Idempotent: a re-run (any agent may run it) writes nothing and
  prints `prd init: exists <path>[ with task "<id>"]` plus the same absolute
  agents-dir line as on creation. Exit `0` when created or already valid (and holding `--task`,
  if given); `1` when `FUSE_PRD` is missing, the router is malformed (never
  touched), the router exists without that task (add it with a `Write` —
  `init` never rewrites it), or creation failed; `2` for usage errors.
  A direct `Write` of the router stays blocked by `protectedPathGuard`,
  which is why this command exists.
- **`status`** — read-only, works **without** `FUSE_PRD=1`.
- **`validate`** — writes, so it **requires `FUSE_PRD=1`**. Runs the
  cross-check; on success, flips the given agent's (or every named
  agent's) sub-tasks to `validated` and promotes the router entry once
  every agent is validated.
- **`compact`** — writes, so it **requires `FUSE_PRD=1`**. Collapses a
  fully-validated task PRD to its compacted shape; refuses if any
  sub-task isn't `validated` yet.

Exit codes and the exact messages, as measured:

| Case | Command | Exit | stderr |
|---|---|---|---|
| No router anywhere under `--root`, no `--id` | `status` | `2` | `no PRD router found under <root>/<home>/apex/prd.json — pass --id <harness>` |
| `--id` given but that harness has no router | `status` | `1` | `no PRD router at <root>/<homeSeg>/apex/prd.json` |
| `init`/`validate`/`compact` without `FUSE_PRD=1` | any of the three | `1` | `` prd <sub> requires FUSE_PRD=1 in <homeSeg>/.env or the project .env `` |
| `init` with an invalid `--task` (incl. `--task=foo`) | `init` | `2` | `usage: harness prd init [--task <id>] [--id <harness>] [--root <dir>] — <id> must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` |
| `init`, no `--id`, zero/several home dirs | `init` | `2` | `<no harness home directory\|several harness home directories (...)> under <root> — pass --id <harness>` |
| `init`, router already present and valid (holding `--task` if given) | `init` | `0` | (stdout, nothing written) `prd init: exists <path>[ with task "<id>"]` + the same `prd init: agent reports go in <abs>/<agent>-prd.json ...` line as on creation |
| `init`, router exists without `--task` | `init` | `1` | `prd init: router <path> exists without task "<task>" — add it with a Write (init never rewrites an existing router)` |
| `init`, router malformed | `init` | `1` | `prd init: <router state description>` — file untouched |
| `init`, cannot create | `init` | `1` | `prd init: cannot create router: <error>` |
| `validate` finds unready sub-tasks | `validate` | `1` | `prd validate: N violation(s)` + one `  - <task>/<agent>/<sub>: <reason>` line per violation |
| `compact` before every sub-task is `validated` | `compact` | `1` | `prd compact: sub-task "<sub>" of agent "<agent>" is not validated` |
| Usage error (missing `<task>`, unknown task/agent) | `validate`/`compact` | `2` | e.g. `no such task "<task>" in PRD router`, `no such agent "<agent>" in task PRD for "<task>"` |
| Success | any | `0` | (empty for `validate`; `compacted: <agents>` or `nothing to compact` for `compact`) |

`status` output for the `auth-refactor` walkthrough (the first slot
already reported, `fuse-typescript:typescript-expert-2` hasn't yet):

```
$ harness prd status --root <project>
Task           Router status  Agents  Sub-tasks done/total  Violations
auth-refactor  assigned       2       1/2                   0
```

`--json` output (same state):

```json
{
  "router": { "auth-refactor": { "prd": "prd/auth-refactor-prd.json", "status": "assigned" } },
  "taskFiles": {
    "auth-refactor": {
      "fuse-typescript:typescript-expert":   { "files": ["src/auth/login.ts"],   "sub-tasks": { "jwt-validation": { "status": "assigned" } } },
      "fuse-typescript:typescript-expert-2": { "files": ["src/auth/session.ts"], "sub-tasks": { "session-store":  { "status": "assigned" } } }
    }
  },
  "reports": {
    "fuse-typescript:typescript-expert": { "auth-refactor": { "jwt-validation": { "status": "done", "modified": ["src/auth/login.ts"], "unchanged": [] } } },
    "fuse-typescript:typescript-expert-2": null
  }
}
```

## FAQ

**My sub-agent's write got refused — why?**
Read the reason in the `[BLOCKED] PRD ownership` prompt — the exact
strings are in [Claiming a slot](#claiming-a-slot-closed-slots-and-resume).
Typical causes: the slot isn't one of your `agent_type`'s slots, it is
already owned by another agent of this session, it is already reported
complete on disk, or you already own a different slot. Run
`harness prd status` and check the task PRD names your agent exactly
(`<agentType>` or `<agentType>-<n>`, n ≥ 2 — with the plugin prefix, e.g.
`fuse-typescript:typescript-expert-2`).

**Why do I see two assignments in my context?**
Your `agent_type` matches more than one slot in the task PRD (e.g.
`fuse-typescript:typescript-expert` matches both
`fuse-typescript:typescript-expert` and `fuse-typescript:typescript-expert-2`).
The context shows every matching slice with the disambiguation header
above so nothing is silently dropped. Nothing to fix — write the report of
the slot you are working on: the first `<project>/<host-home>/apex/prd/agents/<name>-prd.json` write
from your `agent_id` claims that slot (one slot per agent), and every
later write must target the same slot.

**The session was interrupted — how do I resume?**
Relaunch same-type agents in a fresh session: a slot whose sub-tasks are
all `done`/`validated` (or compacted) on disk is closed and cannot be
rewritten, while a partial or absent slot is claimable by any same-type
agent, so the new agents take the open slots.

**Nothing happens at all — why?**
Check, in order: is `FUSE_PRD` set to exactly `"1"`? Does
`<homeSeg>/apex/prd.json` exist (create it with `harness prd init`)? Is the harness one that sends agent
identity at all — Cursor and Kimi never do, so ownership stays
consultative there by design, not by bug.

**How do I turn it off?**
Unset `FUSE_PRD` (or set it to anything other than `"1"`), or delete the
router file — either one alone returns the module to fully inert.

## Known limitations

- **Outside-report rule and sub-directory sessions.** When the session `cwd`
  is a sub-directory `X` that itself legitimately holds
  `X/prd/agents/*-prd.json` (a monorepo package, a fixture dir), writes there
  are denied by the outside-report rule while PRD is on, because
  `<payload cwd>/prd/agents` is part of the denied shape.
- **Bash `cd` is not followed.** In `cd <dir> && … > prd/agents/x-prd.json`
  the relative target is resolved against the payload `cwd`, so the deny
  message can name a misleading path. The Kimi and Cursor denies are verified
  by code path and unit tests only (no real run with a native payload).

- **Cursor's `SubagentStart` slice is built, then dropped.** The
  injection runs the identical code path claude-code uses (confirmed by
  running the same router/task-PRD state through both target ids), but
  Cursor's own response contract has no context channel for a
  non-denied `subagentStart`: `toCursorLifecycleResponse` always
  collapses it to bare `{"permission":"allow"}`. Verified live: the
  output is byte-identical whether the router has a matching assignment,
  no router at all, or `FUSE_PRD` is unset entirely — a Cursor sub-agent
  never sees its PRD slice (so the absolute report path in the slice
  cannot reach it either). The outside-tree report deny below is the only
  protection there: a report written to `<project>/prd/agents/…` is denied
  with the correct absolute path in the message.
  (cline had the same symptom for a different, fixable reason:
  `joinContextResponses` recognized only the Claude-shaped
  `hookSpecificOutput.additionalContext` envelope and silently dropped
  cline's native `{contextModification}` inform shape. That one is now
  fixed — the merge keeps whichever envelope its parts came from, so
  cline receives 476 bytes where it previously received none, and all
  six other targets stay byte-identical. Cursor's gap below is
  structural and remains.)
- **Cursor can't correlate a sub-agent's write to its own identity.** A
  Cursor sub-agent's actual file-write event runs under a session ID
  that shares nothing with the lead's or with the `SubagentStart`
  event's own IDs. Per-write ownership checking on Cursor isn't possible
  today — only the after-the-fact cross-check catches a mismatch.
- **Neither Cursor nor Kimi ever sends an agent identity field at all**
  on a Write/Edit payload, so the harness can't tell who the lead even
  is there. Both targets default to consultative mode permanently,
  rather than guessing at a correlation.
- **No file lock on PRD writes.** The ownership guard makes two agents
  writing the *same* file at once structurally impossible, but a write
  from completely outside the guarded hook path (a human editing the
  file directly in a terminal) isn't something any guard here can see.
- **Kimi's `SubagentStop` block-once is best-effort.** Kimi delivers the
  `SubagentStop` event but ignores its response by protocol, so the
  block never actually stops anything there. The lead `Stop` gate's
  reachability on Kimi is a separate question — see the wiring bullet
  below (unverified).
- **Block-once persistence is tracking-mode-independent, verified.** Both
  `SubagentStop` and lead `Stop` block-once markers are written on
  whichever side `trackJournalEnabled()` reads from — the default
  journal-based session track, or the legacy full-snapshot one under
  `FUSE_TRACK_JOURNAL=0` — so a replay is silent (empty stdout) after the
  first block in both modes. Verified live in both modes; this used to
  only hold under the (default) journal mode.
- **A partial slot of another live session is claimable.** Whether a
  partial slot's owner is still alive is not observable, so a same-type
  agent in another session may claim it. Concurrent lead sessions on the
  same task are unsupported.
- **`MultiEdit` is not seen by the PRD candidate files** (pre-existing):
  `prdCandidateFiles` (`src/runtime/prd/prd-candidate-files.ts`) counts a
  bare `filePath` only for `Write`/`Edit` (or a fanned-out file set such as
  `apply_patch`), so a PRD file written through `MultiEdit` is not evaluated
  by the ownership gate.
- **The lead `Stop` gate (block AND compact hint) — wiring, as checked.**
  Both `prd-stop-gate.ts` functions are target-agnostic in code: no id
  allowlist, same per-target form choice throughout (see the B5/B6 test
  suites). Reachability depends on the marketplace wiring:
  - **claude-code: reachable.** `claude-plugins/plugins/core-guards/hooks/hooks.json`
    declares three `Stop` entries. Entry 1 (line 109) is
    `hook claude-code core --sound stop`: `maybePlaySound()`
    (`src/cli/hook-sound.ts:44`) plays the sound and exits before stdin is
    read, so it never reaches the gate. Entry 2 (lines 113-120) is
    `bun --env-file=.../harness-quiet.env .../bin.mjs hook claude-code core`
    — no `--sound`, so it reads the Stop payload; `harness-quiet.env` sets
    `FUSE_HARNESS_SOUND=0` so the sound is not doubled. The `Stop` case in
    `src/runtime/lifecycle/dispatch.ts:89-94` (scope `core`) calls
    `prdStopGate(...)` first. The hooks.json `description` states the same
    intent (`Stop[1]: Lead-Stop guards ... PRD cross-check block-once +
    compact hint`). Not verified live: that the *installed* harness build
    on a given machine contains this dispatch.
  - **Codex and Kimi: unverified.** Their plugin repos
    (`codex-plugins`/`kimi-code-plugins`) are not in this checkout, so their
    Stop wiring was not read. An earlier revision of this document claimed
    those targets' Stop hook "always carries `--sound stop`"; that claim is
    not established here and was wrong for claude-code.
  - Hermes (26 `VALID_HOOKS`, per its own plugin docs) and Gemini CLI
  (11 lifecycle events, per its own hook reference) have no event literally
  named `Stop` at all; their closest analogs (`on_session_end`,
  `SessionEnd`) either ignore the hook's return value or are documented
  "Best Effort" with all flow-control fields ignored. Cline's own init
  template this harness ships (`clineInit`) wires only
  `PreToolUse`/`PostToolUse`. Should any of these targets grow a
  genuinely reachable non-blocking Stop channel, nothing in
  `prd-stop-gate.ts` needs to change — it already mirrors the block path's
  per-target form for every id; only the external wiring would need to
  change.

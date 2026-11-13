# Guards — `@fusengine/harness/policy`

Five portable enforcement guards, composed into `evaluate()` via a
`runGuards` chain (first firing guard wins, ahead of git + file-size). Each is a
pure `(ctx: GuardContext) => Prompt | null`.

```ts
import { runGuards, type GuardContext } from "@fusengine/harness/policy";

const hit = runGuards({ tool: "Bash", command: "rm -rf /" });
// → { kind: "block", title: "Dangerous command", reason: "...", actions: [...] }
```

`GuardContext` is `{ tool, filePath?, content?, command? }`. A guard returns a
portable `Prompt` (`kind: "block" | "ask" | "inform"`) or `null` to continue.

**Extensible + fail-closed.** `registerGuard(fn)` adds a user guard that runs
**after** the privileged core chain (two-tier — the core can't be bypassed; use
`clearUserGuards()` to reset). `runGuards` is **fail-closed**: a guard that throws
returns a block (`FAIL_CLOSED`), never a silent pass — and the runtime `gate`
wraps `evaluate`/`evaluateApex` the same way, so a bug can never disable enforcement.

## The chain (evaluation order)

| Guard | Fires when | kind |
|-------|-----------|------|
| `gitFlowGuard` | branch-name convention, `gh pr merge` with squash/rebase (runs first so an ask can't hide it) | block |
| `confirmRelayGuard` | a `CONFIRM <code>` relayed through a nested agent CLI or session typer (`codex exec`, `kimi -p`, `claude -p`, `npx …`, `tmux send-keys`, …) — every host; see [adapters.md](./adapters.md#confirm-relay-guard-core-path-every-host) | block |
| `securityGuard` | `rm -rf /\|/etc\|/usr…`, recursive `rm` of `/`, `~`, a home or top-level system directory (any spelling, also behind wrappers), fork bomb, `curl \| sh`, `mkfs`/`shred`/`fdisk`/`diskutil erase`, `> /dev/{sda,hda,nvme}` | block |
| | `sudo`/`su`/`doas`/`passwd`, `chmod 777`, recursive `chown`, `eval`, `rm`/`unlink`, write to `/etc` | ask |
| `protectedPathGuard` | Write/Edit under `.claude/plugins\|logs\|cache`, `.git/` | block |
| `bashWriteGuard` | `sed -i`, heredoc/redirect to a code file, `python3 -c` whose inline script mutates files/spawns a process (content-gated — same treatment as `node -e`, a read-only one-liner passes); literal-text writes (`echo`/`printf`/heredoc/`tee`) to an ordinary non-code file ("use Write/Edit"); `cp`/`mv`/`install`/`ln` of provably foreign content (temp/scratchpad or non-code source, or a source outside the project) onto a project code file | block |
| | other redirects to a non-code file, `tee`, `dd of=`, `node -e` writes | ask |
| | *allowed:* a redirect proven inside the session scratchpad, and one simple read-only producer (or read-only `git` report) whose output goes straight to the scratchpad or system temp | — |
| `interfaceSeparationGuard` | top-level `interface`/`type`/`protocol`/`record` in a TS/JS/Vue/Svelte, Python, **Go**, **Java/Kotlin**, PHP, or Swift component/view/controller/handler | block |
| `installGuard` | `npm/yarn/pnpm/bun/pip/cargo/go/gem/composer` + `brew/apt/dnf/pacman` installs | ask |
| `opaqueShellGuard` | last in the chain: a command or shell payload built at run time that cannot be analysed (`sh -c "$CMD"`, `$CMD args`, …) | ask |

Plus, inside `evaluate()` after the chain:
- **git** — destructive ops (`push --force`, `reset --hard`, `branch -D`…) → **block**;
  routine ops (`push`, `checkout`, `commit`, `add`, `branch -d`, `merge`…) → **ask**.
- **ssh to shell** — `ssh host '…' | sh` (bash/zsh, with or without `sudo`) → **ask**,
  consulted last and only when everything else would allow. A single plain
  `ssh [options] host 'payload'` to a proven-remote host is judged on its local
  view only (local-only labels such as `sudo` or plain `rm` don't apply to the
  remote payload).
- **rm on Codex/Kimi/Cursor** — the generic `rm` ask is degraded to a deny with a
  trash hint and, for a single literal non-root `rm`, a one-time `CONFIRM` code;
  see [adapters.md](./adapters.md#rm-on-hosts-without-interactive-approval).
- **file-size** — over `FUSE_SOLID_MAX_LINES` (default 100). A **Write** judges its
  new content; an **Edit** judges the existing on-disk file. `Explore`/`Plan` agents are exempt.
- **verbosity** (`capVerbosity`) — caps exa `numResults`≤3 + `tokensNum`≤2000 and
  Context7 `tokens`≤2000 (applied as an input mutation, not a block).

## APEX gates (stateful)

The gates in `policy/apex` need session state (supplied by `runtime`): they form
their own chain via `evaluateApex(ctx)`:

| Gate | Blocks until |
|------|-------------|
| `brainstormGate` | brainstorming ran (when creation intent flagged a new file) |
| `freshnessGate` | `explore-codebase` + `research-expert` ran within the window |
| `docConsultedGate` | Context7 **and** Exa consulted this session |
| `solidReadGate` | the routed SOLID refs (`FUSE_HARNESS_REFS`) were read |

Each is individually exported and overridable — pass your own array to
`evaluateApex(ctx, gates)`.

## PRD ownership

Opt-in (`FUSE_PRD=1`), documented in full at [prd.md](./prd.md). It adds a
per-file write-ownership check on top of the chain above: only the
coordinator may write the router or a task PRD, and only the named agent
may write its own `prd/agents/<agent>-prd.json` report.

This authorized PRD traffic is what actually needs a carve-out from
`protectedPathGuard` above: that guard already lists `.claude/apex/`
under its blocked fragments, so every PRD file lives inside a path the
chain blocks by default. When PRD is active, a write the ownership check
allows short-circuits past the rest of `evaluate()` — including the
file-size and APEX-freshness gates — the same way `Explore`/`Plan`
agents are already exempt from file-size today. Nothing changes when PRD
is off: `protectedPathGuard` keeps blocking `.claude/apex/**` exactly as
it always has.

**A mixed `apply_patch` envelope never gets this short-circuit, even for
its legitimate file.** `prdPreGate` only allows-through a PURE-PRD
envelope, where every candidate file classifies in-scope
(`inScope.length === files.length`); the moment a single `apply_patch`
call mixes one PRD-scoped file with any other, unrelated file,
`prdPreGate` returns `null` for the whole call and it falls through to
`applyPatchGate`'s ordinary per-file `protectedPathGate` — which
unconditionally blocks the `.claude/apex/` file, same as if PRD were off.
Verified live: an `apply_patch` envelope touching only the agent's own
`prd/agents/<agent>-prd.json` report is allowed; the identical hunk for
that same file, bundled in ONE envelope with an unrelated `Add File:` for
a normal source file, is denied with `[BLOCKED] Protected path` — not
`[BLOCKED] PRD ownership` — even though the PRD file's own ownership
would otherwise have been legitimate.

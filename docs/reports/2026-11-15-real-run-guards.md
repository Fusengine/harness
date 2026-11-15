# Real-run proof of the three merged harness fixes (2026-11-15)

Branch `fix/lead-guards-receipt-noask` = origin/main (5d5c963) + `fix/receipt-own-writes` + `fix/commit-agent-no-ask` + `feat/lead-outcome-scope-guards` (three `--no-ff` merges, no conflicts).

## Method

- Real Claude Code 2.1.325, `claude -p`, run in a throwaway git repo (`main` + `feat/demo`) under the session scratchpad.
- Hooks registered in the throwaway project's `.claude/settings.json` with `--setting-sources project` (so no user or plugin hook runs): Stop, SubagentStop, PostToolUse (Write|Edit|Bash), PreToolUse (Agent|Task|Bash). Each command is a thin logger that pipes the REAL hook payload to this worktree's built `dist/cli/bin.mjs hook claude-code` (core scope), then logs the payload essentials and the real response. The hook process runs with a throwaway `HOME`; `~/.claude` is never written.
- The lines below are the logged events, only trimmed and path-sanitised (`<proj-root>`). Responses are exactly what Claude Code received.

## (a) Status-only final after a notification: blocked once, passes on continuation

Prompt: start `sleep 6; echo bgfinished` in the background, answer "Waiting for the background job." right away, and answer "Background job finished, standing by." when the completion notification arrives.

Result: the first Stop (turn opened by the owner prompt) is NOT blocked. The second Stop (turn opened by the background-task notification, status-only, no outcome marker) is blocked once. Claude Code continues with `stop_hook_active: true` and the next Stop passes; it passes because of the `stop_hook_active` short-circuit (never two blocks in a row), not because of the message classification. A notification-opened turn with `stop_hook_active=false` that ends on an outcome (the false-positive case) is covered by `lead-guard-outcome` unit tests only, not by this real run.

```
02:35:03 Stop lead stop_hook_active=false final="Waiting for the background job."
    -> response: (empty = allow)
02:35:10 Stop lead stop_hook_active=false final="Background job finished, standing by."
    -> response: {"decision":"block","reason":"Status-only relay blocked (owner rule: report outcomes only). Say an outcome (link, commit hash, PR number, file, numbers, version, table) or ask the owner a question / give the command to type. If there is nothing to report yet, end the turn with one very short word, in the owner's language."}
02:35:14 Stop lead stop_hook_active=true final="The background job finished with exit code 0 and printed `bgfinished`."
    -> response: (empty = allow)
```

## (b) Agent brief without an owner quote is denied

Prompt: call the Agent tool with the prompt "Reply with the single word hi. Do not do anything else." (no OWNER RULES section). The PreToolUse hook returned a deny and no sub-agent was created (the model's final message confirms it).

```
02:33:36 PreToolUse(Agent) lead subagent=general-purpose
    -> response: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[BLOCKED] Brief without the owner's words\nBrief refused: its OWNER RULES section must quote the owner's real words verbatim, « like this », and at least one quote must appear in a user message of this session; add the owner's actual words, never paraphrase or invent."},"systemMessage":"✘ Brief without the owner's words"}
```

Positive control: a brief with an `OWNER RULES:` section quoting words of the owner's real message is allowed (empty response on the PreToolUse(Agent) lines in (d)).

## (c) `git commit` on a feature branch: no ask; on `main`: ask

On `feat/demo` the PreToolUse(Bash) response is empty (allow) and the commit runs (`[feat/demo b5b9512]`). On `main` the response is `permissionDecision: "ask"` and the commit does not run (`git log` holds only `init`).

```
# feat/demo
02:31:49 PreToolUse(Bash) lead cmd=git commit --allow-empty -m 'chore: demo on feature branch'
    -> response: (empty = allow)
# main
02:33:10 PreToolUse(Bash) lead cmd=git commit --allow-empty -m 'chore: demo on main'
    -> response: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[CONFIRM] Confirm git operation\nAuthorize: git commit --allow-empty -m 'chore: demo on main'\nNext:\n 1. Approve if this git operation is intended"},"systemMessage":"? Confirm git operation"}
```

There is no real-run control against an `origin/main` build for (c); the contrast with the old behaviour is covered by `git-wip-no-ask` and `git-wip-refuse` unit tests.

## (d) A sub-agent's Stop is not blocked by the lead's unrelated files

Run 1: the lead writes `src/greeting.ts` (its own file, no receipt), then dispatches a sub-agent that writes nothing. SubagentStop returns a plain completion message (no block). The LEAD's own Stop is still gated by the receipt, since the lead owns the file.

```
02:34:01 PostToolUse(Write) lead file=<proj-root>/proj/src/greeting.ts
    -> response: SNIPER VALIDATION REQUIRED (additionalContext) for greeting.ts
02:34:06 PreToolUse(Agent) lead subagent=general-purpose
    -> response: (empty = allow)
02:34:07 SubagentStop agent=general-purpose stop_hook_active=false final="hi"
    -> response: {"message":"Agent general-purpose completed (no code changes)"}
02:34:10 Stop lead stop_hook_active=false
    -> response: {"continue":false,"stopReason":"VERIFICATION RECEIPT REQUIRED: code files changed but no fresh passing verification receipt exists. Run npm test (exit 0, 0 failures), then re-complete."}
```

Run 2 (precise attribution): the lead writes `src/lead.ts`, the sub-agent writes `src/sub.ts`. The sub-agent's block names ONLY `src/sub.ts`, never the lead's `src/lead.ts`; the next SubagentStop (`stop_hook_active: true`) passes.

```
02:36:23 PostToolUse(Write) lead file=<proj-root>/proj/src/lead.ts
02:36:31 PostToolUse(Write) agent=general-purpose file=<proj-root>/proj/src/sub.ts
02:36:33 SubagentStop agent=general-purpose stop_hook_active=false final="done"
    -> response: {"decision":"block","reason":"SNIPER VALIDATION REQUIRED: Agent 'general-purpose' modified 1 code file(s): <proj-root>/proj/src/sub.ts. Run sniper agent now. NO VERIFICATION RECEIPT — run npm test before reporting done."}
02:36:38 SubagentStop agent=general-purpose stop_hook_active=true
    -> response: {"message":"Agent general-purpose completed (no code changes)"}
```

Caveats: the second SubagentStop answers "completed (no code changes)" although `src/sub.ts` was written (each agent/file is demanded once, `remindedAt`), so the hard block is a one-time reminder, not a barrier. Run 1 is a negative control for the new hard block on release: main never emits `decision:block` on SubagentStop.

Note on the control: run 1 replayed against an `origin/main` build also lets the sub-agent through, so run 1 alone does not discriminate fixed from unfixed. The pre-fix defect depends on the session-wide attribution fallback and is covered by the unit tests `receipt-own-writes` and `subagent-stop-receipt-block`; run 2 is the positive proof of precise attribution in the real tool.

## (e) Scope guard usability fix: SendMessage follow-ups and read-only built-ins

Change: `SendMessage` is checked only when its message carries an `OWNER RULES` header (a new mandate); `Agent`/`Task` spawns keep the full check; `web-fetch` and `claude-code-guide` join `HELPER_AGENT_TYPES`. Same real-run method, rebuilt `dist` (hooks matcher extended with `SendMessage`).

```
03:16:34 PreToolUse(Agent) subagent=general-purpose (brief with a quote of the owner's prompt)   -> ALLOW
03:16:38 PreToolUse(SendMessage) message="Follow-up, reply hi now.\nWRITE: nothing\nPROOF: hi"    -> ALLOW   (2 fixed headers, no OWNER RULES: denied before the fix)
03:17:12 PreToolUse(Agent) subagent=general-purpose, prompt "Reply with the word hi."             -> deny "Brief without the owner's words"  (non-helper spawn still denied)
03:17:28 PreToolUse(Agent) subagent=web-fetch, no quote                                           -> ALLOW   (read-only built-in)
03:18:19 PreToolUse(SendMessage) "OWNER RULES: « <invented French sentence> »\nWRITE: nothing..."  -> deny "Brief without the owner's words"  (invented quote still denied)
```

Real re-run after the regex fix (rebuilt dist): `SendMessage` with `Owner rules: « <invented sentence> »` -> deny "Brief without the owner's words" (06:45:13).

Challenger round on (e): REFUTED the claim "no denial weakened" on first pass. A probe replayed on HEAD and on the worktree showed that a respelled header (`Owner rules:`, double space, no-break space) with an invented quote was blocked before (the old 2-header count caught it) and passed after. Fixed: `OWNER_HEADER_RE` is now `/OWNER[\s_-]+RULES/i` (unit-tested for those variants and for `OWNER_RULES` / `owner-rules`). Open points left to the owner, not changed (outside the requested scope):
- A SendMessage without the header can resume a finished agent (Claude Code "Resuming agent"), i.e. re-task it without a quote. This is the requested behaviour for follow-ups.
- Helper matching strips any `plugin:` prefix, so `x:web-fetch` / `x:claude-code-guide` (like `x:sniper` before) are exempt. Pre-existing mechanism, two names added.
- Production wiring: `claude-plugins` `core-guards` hooks.json PreToolUse matcher has no Agent|Task|SendMessage, and the `ai-pilot` entry (`Agent|Task`) runs scope `aipilot`, where `leadScopeGate` is inert (core scope only). The installed plugins may therefore never fire the scope guard; the real run used a hand-written matcher. Not verified against an installed plugin set.

Test-method note: a first attempt at the invented-quote case (03:17:49, ALLOW) was an artifact: the quote was written in the owner's own prompt, so it was a real owner quote. It was re-run with a sentence absent from the prompt (03:18:19, deny). The (e) follow-up was sent to a real named background agent (`worker1`) in the same session.

## Not verified

- The receipt-own-writes defect itself (lead's Stop blocked by a sub-agent's files) was not reproduced against origin/main in the real tool; it is proven by the unit tests only.

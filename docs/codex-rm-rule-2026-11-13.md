# Codex rm prompt rule removal (2026-11-13)

Status: code DONE, install BLOCKED (protected-path guard), live run NOT RUN.

## Cause
`~/.codex/rules/fusengine.rules` carried `prefix_rule(pattern=["rm"], decision="prompt")` plus
`/bin/rm` and `/usr/bin/rm` aliases. Under `approval_policy="never"` Codex turns a prompt rule
into Forbidden, so the harness hook's one-time `CONFIRM <code>` could never authorize `rm`.

## Change (branch fix/codex-rm-rule, worktree fuse-harness-wt-codexrm, from 3ca624b)
- `src/codex-rules/rules/ask.ts`: removed the rm prompt rule (the /bin and /usr/bin aliases derive
  from it in `mapping.ts`, so they disappear with it).
- `src/codex-rules/skip-list.ts`: rm label moved to the skip-list with a reason.
- `test/codex-rules-rm.test.ts` (new): no prompt rule on rm, /bin/rm, /usr/bin/rm; skip-list carries
  the label with a CONFIRM / approval_policy reason; forbidden rm variants remain; unlink kept;
  prompt rule count 28 -> 25.
- Unchanged: unlink, chown -R, eval, chmod, dd, curl/wget prompts; every forbidden rule.

## Proof
- RED: 3 of 4 new tests failed before the change (offenders present, no skip entry, 28 prompts).
- GREEN: `bun test test/codex-rules-rm.test.ts test/codex-rules.test.ts` 15 pass, 0 fail
  (anti-drift tests included). `bunx tsc --noEmit` exit 0.
- Generated with `bun src/cli/bin.ts codex-rules --out <file>` (the command the installer runs via
  dist/cli/bin.mjs; it writes the body only, the installer prepends the marker line).
  Pre-change generator output equals the installed file except the marker line (verified by diff).
- New file = marker line `# fusengine:exec-policy harness@0.1.115` (kept identical) + new body.
  Diff installed vs new: exactly the 3 rm prompt blocks (rm, /bin/rm, /usr/bin/rm) removed, plus
  one added header comment line listing the rm skip-list reason. Nothing else differs.

## Blocked
Installing into `~/.codex/rules/` is refused by the protected-path guard
(`src/policy/guards/protected-path.ts`). Owner command:

    mv ~/.codex/rules/fusengine.rules ~/.Trash/fusengine.rules-pre-rm-2026-11-13 && cp <scratch>/codex-rm-rule/fusengine.rules.new ~/.codex/rules/fusengine.rules

Rollback: move the new file to Trash, then
`mv ~/.Trash/fusengine.rules-pre-rm-2026-11-13 ~/.codex/rules/fusengine.rules`.

## Not verified
Live Codex yolo run (steps a-f), because the installed rules are unchanged.

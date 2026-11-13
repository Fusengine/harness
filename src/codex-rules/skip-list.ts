import type { CodexSkipEntry } from "./types";

/**
 * `security.ts` labels with NO argv-prefix equivalent. Every entry here is
 * shell syntax (pipes, redirection, function-definition syntax) that never
 * appears as a plain argv token when a command is exec'd without a shell —
 * Codex execpolicy's `prefix_rule` cannot express them. Covered instead by
 * `sandbox_mode`/`approval_policy`. Never drop a label silently: it is
 * either a prefix_rule (see `rules/`) or an entry here.
 */
export const SKIP_LIST: CodexSkipEntry[] = [
  {
    sourceLabel: "DELETE: 'rm' permanently deletes - confirmation required",
    reason:
      "rm is gated by the PreToolUse hook with a one-time CONFIRM code and a trash hint; a Codex prompt rule turns into Forbidden under approval_policy=never and makes that code unusable. rm -rf of / ~ and system dirs stay forbidden (rules/rm-variants.ts).",
  },
  {
    sourceLabel: "DANGEROUS PATTERN: fork bomb",
    reason:
      "Shell function-definition syntax `:(){ :|:& };:` is not a single argv invocation — no prefix_rule can express it.",
  },
  {
    sourceLabel: "DANGEROUS PATTERN: redirect to a raw disk device",
    reason: "`>`/`>>` redirection to /dev/sda is shell syntax, invisible to argv-prefix matching.",
  },
  {
    sourceLabel: "DANGEROUS PATTERN: write to /etc",
    reason: "`>`/`>>` redirection into /etc/* is shell syntax, invisible to argv-prefix matching.",
  },
];

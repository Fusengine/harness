import type { CodexPrefixRule } from "../types";

/**
 * `prompt`-decision rules — hand-mapped 1:1 from `security.ts`'s
 * ASK_PATTERNS. `DANGEROUS PATTERN: chmod 777` lives in `chmod-ask.ts`
 * (needed multiple flag-order variants). `DANGEROUS PATTERN: write to /etc`
 * is intentionally absent here: it fires on shell redirection
 * (`> /etc/...`), which is not a single argv invocation — see
 * `../skip-list.ts`.
 */
export const ASK_RULES: CodexPrefixRule[] = [
  {
    sourceLabel: "DANGEROUS PATTERN: recursive chown",
    pattern: ["chown", "-R"],
    decision: "prompt",
    justification: "Recursive ownership change; confirm scope.",
    match: ["chown -R user:user /srv/app"],
    notMatch: ["chown user file.txt"],
  },
  {
    sourceLabel: "DANGEROUS PATTERN: eval",
    pattern: ["eval"],
    decision: "prompt",
    justification: "Evaluates arbitrary shell input.",
    match: ["eval $(cat script.sh)"],
    notMatch: ["node eval.js"],
  },
  {
    sourceLabel: "DELETE: 'unlink' command detected - confirmation required",
    pattern: ["unlink"],
    decision: "prompt",
    justification: "unlink permanently removes a file; confirm before running.",
    match: ["unlink file.txt"],
    notMatch: ["ln -s a b"],
  },
];

import type { Prompt } from "../../prompt/types";

/** Hard block for a Bash write that lands code in a code file (use Write/Edit instead). */
export function blockCodeWrite(reason: string): Prompt {
  return { kind: "block", title: "Bash write to code file", reason, actions: ["Use the Write/Edit tool instead"] };
}

/**
 * The stricter of a base verdict and an add-on verdict: a block always wins (the base block is kept when both block,
 * so its message is unchanged); otherwise the base verdict stands, the add-on only fills a null.
 */
export function strictest(base: Prompt | null, extra: Prompt | null): Prompt | null {
  if (base?.kind === "block") return base;
  if (extra?.kind === "block") return extra;
  return base ?? (extra && extra.kind !== "ask" ? extra : null);
}

/** Ask-tier prompt for a Bash file write. */
export function askFileWrite(reason: string, ruleId = "bash-write:file-write"): Prompt {
  return { kind: "ask", ruleId, title: "Bash file write", reason, actions: ["Use the Write/Edit tool instead"] };
}

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

/**
 * Block for a Bash file redirect issued by a sub-agent: nobody answers an `ask` there, so the agent would wait for
 * hours. The message says exactly how to proceed instead: the full-path form it suggests is the one both
 * auto-approval windows accept (read-only commands and git reports alike).
 * @param scratchpadDir - Session scratchpad from the host payload, spelled out in the instructions when known.
 */
export function blockSubagentRedirect(scratchpadDir?: string): Prompt {
  const dir = scratchpadDir || "<scratchpad dir>";
  return {
    kind: "block",
    ruleId: "bash-write:file-redirect",
    title: "Bash file write",
    reason: "This shell redirect cannot be auto-approved and nobody can answer a confirmation in a sub-agent.",
    actions: [
      "Write the file with the Write tool (path inside the session scratchpad)",
      `Or run ONE simple command with a plain redirect to the full scratchpad path: cmd args > ${dir}/file (unquoted plain words only: no quotes, { } group, backslash, # or $( )), then run the rest in separate commands`,
    ],
  };
}

/** Ask-tier prompt for a Bash file write. */
export function askFileWrite(reason: string, ruleId = "bash-write:file-write"): Prompt {
  return { kind: "ask", ruleId, title: "Bash file write", reason, actions: ["Use the Write/Edit tool instead"] };
}

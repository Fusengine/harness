import type { Prompt } from "../../prompt/types";

/** Context handed to every guard in the chain. */
export interface GuardContext {
  tool: string;
  filePath?: string;
  content?: string;
  command?: string;
  /** Exact session scratchpad dir from the Claude Code payload (`scratchpad_dir`); undefined on every other host. Only the Bash redirect window reads it. */
  scratchpadDir?: string;
}

/** A single guard: returns a blocking/asking Prompt, or null to continue. */
export type Guard = (ctx: GuardContext) => Prompt | null;

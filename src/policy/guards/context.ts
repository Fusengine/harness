import type { Prompt } from "../../prompt/types";

/** Context handed to every guard in the chain. */
export interface GuardContext {
  tool: string;
  filePath?: string;
  content?: string;
  command?: string;
  /** Exact session scratchpad dir from the Claude Code payload (`scratchpad_dir`); undefined on every other host. Only the Bash redirect window reads it. */
  scratchpadDir?: string;
  /** Absolute cwd from the host payload (where the shell starts); undefined when the host sent none. Only the Bash literal-write block resolves relative targets against it. */
  cwd?: string;
}

/** A single guard: returns a blocking/asking Prompt, or null to continue. */
export type Guard = (ctx: GuardContext) => Prompt | null;

import { bashWriteGuard } from "../../src/policy/guards/bash-write";
import { literalWrites } from "../../src/policy/guards/bash-write-literal";

/** Verdict of the Bash write guard for `command` (`allow` = no Prompt), optionally inside a scratchpad window and from a payload cwd. */
export function guardVerdict(command: string, scratchpadDir?: string, cwd?: string): "allow" | "ask" | "block" {
  const r = bashWriteGuard({ tool: "Bash", command, scratchpadDir, cwd });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

/**
 * Verdict of a frozen `ask` row once literal text written through the shell is refused: `block` when the whole
 * command is fully literal (see bash-write-literal.ts), the unchanged `ask` otherwise.
 */
export function askNow(command: string): "ask" | "block" {
  return literalWrites(command) === null ? "ask" : "block";
}

/** `old` (verdict frozen from main) carried to the current guard: only a literal `ask` row moved, to `block`. */
export function nowOf(command: string, old: "allow" | "ask" | "block"): "allow" | "ask" | "block" {
  return old === "ask" ? askNow(command) : old;
}

/** Fake session scratchpad dir (literal, never touched on disk) used by the redirect-narrowing corpus. */
export const D = "/private/tmp/claude-501/-Users-me-proj/aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb/scratchpad";
/** Fake project root used as the "must never be written silently" target. */
export const P = "/Users/me/proj";

/** One corpus row: `cmd` is a template (`@D` = scratchpad, `@P` = project). */
export interface CorpusRow {
  id: string;
  cmd: string;
  /** Verdict of the guard WITHOUT the scratchpad window, frozen from a real run: main's, except `&>`/`>&file` rows where the amp branch intentionally tightened allow to ask. */
  old: "allow" | "ask" | "block";
  /** The only rows allowed to flip to allow. */
  safe?: boolean;
}

/** Expand the `@D` / `@P` placeholders of a corpus template. */
export function expand(cmd: string): string {
  return cmd.replaceAll("@D", D).replaceAll("@P", P);
}

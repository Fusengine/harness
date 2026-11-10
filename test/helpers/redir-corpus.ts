/** Fake session scratchpad dir (literal, never touched on disk) used by the redirect-narrowing corpus. */
export const D = "/private/tmp/claude-501/-Users-me-proj/aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb/scratchpad";
/** Fake project root used as the "must never be written silently" target. */
export const P = "/Users/me/proj";

/** One corpus row: `cmd` is a template (`@D` = scratchpad, `@P` = project). */
export interface CorpusRow {
  id: string;
  cmd: string;
  /** Verdict of the pre-change guard (main), frozen from a real run. */
  old: "allow" | "ask" | "block";
  /** The only rows allowed to flip to allow. */
  safe?: boolean;
}

/** Expand the `@D` / `@P` placeholders of a corpus template. */
export function expand(cmd: string): string {
  return cmd.replaceAll("@D", D).replaceAll("@P", P);
}

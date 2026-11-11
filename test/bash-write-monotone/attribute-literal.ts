/**
 * MONO_ATTRIBUTOR module for differential.ts: category (a), literal Bash text refused in favour of
 * Write/Edit, decided by bw-fix's own classifier (never duplicated here). A tightened row whose command
 * the classifier reports as a literal write is attributed to (a); everything else is left to the
 * built-in categories.
 *
 *   MONO_ATTRIBUTOR=$PWD/test/bash-write-monotone/attribute-literal.ts bun test/bash-write-monotone/differential.ts diff base.json cand.json
 */
import { literalWriteBlock } from "../../src/policy/guards/bash-write-literal";

/**
 * Attribute one differential row to category (a) when the classifier sees a literal Bash write.
 * @param _tag - Row tag (unused).
 * @param cmd - The command of the row.
 * @param dir - Verdict direction of the row.
 * @returns The category label for a tightened literal write, otherwise null.
 */
export default function attributeLiteral(_tag: string, cmd: string, dir: "loosened" | "tightened"): string | null {
  return dir === "tightened" && literalWriteBlock(cmd) !== null ? "(a) literal text -> Write/Edit refusal (bash-write-literal classifier)" : null;
}

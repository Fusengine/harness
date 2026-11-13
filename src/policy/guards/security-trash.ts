import type { Effective } from "../effective-segments";
import { rmOperands } from "./security-rm-root";

/** A path component naming a trash directory: `.Trash`, `.Trashes`, `Trash`, `.trash` (exact, case-insensitive). */
const TRASH_DIR = /^(?:\.Trash|\.Trashes|Trash|\.trash)$/;
/** Characters that make an operand non-literal (expansion, substitution, brace/glob other than a trailing `*`). */
const NON_LITERAL = /[$`{}()!?\[\]\\;&|<>*]/;

/** True when `operand` is a literal path strictly inside a trash directory (`~/.Trash/x`, `/Users/me/.Trash/*`); no `..`, no expansion. */
function insideTrash(operand: string): boolean {
  if (operand.startsWith("~") && !operand.startsWith("~/")) return false;
  const parts = operand.split("/").filter((c) => c !== "" && c !== "." && c !== "~");
  if (parts.includes("..")) return false;
  const last = parts.length - 1;
  const at = parts.findIndex((c) => TRASH_DIR.test(c));
  if (at < 0 || at >= last) return false;
  return parts.every((c, i) => !NON_LITERAL.test(i === last ? c.replace(/^\*$/, "") : c));
}

/**
 * True when the command really runs at least one `rm` and EVERY `rm` it runs
 * only deletes inside a trash directory (the one case where the rm
 * confirmation is waived). The word "trash" elsewhere (a comment, an `echo`,
 * a file called `trash-me`) exempts nothing.
 * @param items - Commands found by `expand`.
 */
export function isTrashDelete(items: readonly Effective[]): boolean {
  const rms = items.filter((i) => i.verb === "rm");
  // A wrapper that appends operands (`echo ~ | xargs rm -rf ~/.Trash/x`) deletes more than the written path.
  return rms.length > 0 && rms.every((rm) => {
    if (rm.appends) return false;
    const ops = rmOperands(rm.argv);
    return ops.length > 0 && ops.every(insideTrash);
  });
}

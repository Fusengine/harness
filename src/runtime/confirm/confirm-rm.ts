import type { Prompt } from "../../prompt/types";
import { expand, type Effective } from "../../policy/effective-segments";
import { TOP_DIRS, rmOperands, rmOptions, rmTargetsRoot } from "../../policy/guards/security-rm-root";

/** Label fragment of the generic `rm` ask raised by the security guard (kept verbatim: the Kimi shim classifies on it). */
const RM_ASK = "DELETE: 'rm'";
/** Command text that makes a line more than ONE plain statement: separators, pipes, redirects, groups, substitutions, escapes, newlines. */
const NOT_SIMPLE = /[;&|<>()`$\\\n\r]/;
/** Characters that make an operand non-literal (glob, brace, history, bracket). */
const NON_LITERAL = /[*?[\]{}!]/;
/** Options a confirmable `rm` may carry; anything else (`--no-preserve-root`, `--one-file-system`, …) stays unconfirmable. */
const SAFE_OPTION = /^(?:-[rRfvdi]+|--(?:recursive|force|verbose|dir))$/;
/** Most targets named in a trash hint; beyond it the generic hint is shown. */
const MAX_HINT_TARGETS = 5;

/** Parents of home directories and of the macOS `/private` tree: judged by depth below, not as system directories. */
const PARENTS: readonly string[] = ["private", "users", "home"];
/** Top-level system directories, lower-cased: macOS volumes are case-insensitive (`/USR`, `/library` are the real ones). */
const SYSTEM_TOPS: ReadonlySet<string> = new Set(TOP_DIRS.map((d) => d.toLowerCase()).filter((d) => !PARENTS.includes(d)));

/** True for an absolute path that is a top-level entry itself (`/tmp`, `/cores`), a system tree, or a home directory (`/users/me`), in any letter case. */
function isSystemPath(operand: string, parts: readonly string[]): boolean {
  if (!operand.startsWith("/")) return false;
  const below = (parts[0] ?? "").toLowerCase() === "private" ? parts.slice(1) : parts;
  const top = (below[0] ?? "").toLowerCase();
  return below.length <= 1 || SYSTEM_TOPS.has(top) || (["users", "home"].includes(top) && below.length <= 2);
}

/**
 * Canonical spelling of a literal operand (repeated slashes and `.` components
 * removed, so `/./usr` and `/Users//me` read like `/usr` and `/Users/me`), or
 * `null` when it is not a plain literal target: expansion or glob, `~user`, a
 * `..` component, the cwd / `/` / `~` itself, or a path under a system directory.
 */
function canonical(operand: string): string | null {
  if (operand === "" || NON_LITERAL.test(operand)) return null;
  const parts = operand.split("/").filter((c) => c !== "" && c !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  const home = parts[0] === "~";
  if (operand.includes("~") && !(home && operand.startsWith("~/") && parts.length > 1 && parts.slice(1).every((c) => !c.includes("~")))) return null;
  if (isSystemPath(operand, parts)) return null;
  return `${operand.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

/** A literal operand that {@link canonical} accepts. */
const isLiteralTarget = (operand: string): boolean => canonical(operand) !== null;

/**
 * True when the WHOLE command is one plain, unwrapped `rm` statement with only
 * literal operands, none of them a root, home or system directory (those stay
 * hard-blocked by the security guard and are never confirmable here).
 * @param cmd - The command a prompt is about.
 */
export function isConfirmableRm(cmd: string): boolean {
  if (NOT_SIMPLE.test(cmd) || !/^\s*rm\s/.test(cmd)) return false;
  const { items, opaque } = expand(cmd);
  const item: Effective | undefined = items[0];
  if (opaque || items.length !== 1 || !item || item.verb !== "rm" || item.appends) return false;
  const operands = rmOperands(item.argv);
  if (operands.length === 0 || !operands.every(isLiteralTarget) || !rmOptions(item.argv).every((o) => SAFE_OPTION.test(o))) return false;
  // Root-likeness is judged on the canonical spelling and as if the delete were recursive: a plain `rm -f ~` is no safer to confirm.
  return !rmTargetsRoot([{ ...item, argv: ["-r", "--", ...operands.map((o) => canonical(o) ?? o)] }]);
}

/** Single-quote a path holding whitespace so the `mv` hint stays one command. */
const shown = (path: string): string => (/\s/.test(path) ? `'${path}'` : path);

/**
 * The one-line trash suggestion for a denied `rm` ask: the literal targets when
 * every `rm` the line runs names only literal ones, else a generic `<path>`.
 * @param command - The command the ask is about.
 */
export function trashHint(command: string): string {
  const operands = expand(command).items.filter((i) => i.verb === "rm").flatMap((i) => rmOperands(i.argv));
  const literal = operands.length > 0 && operands.length <= MAX_HINT_TARGETS && operands.every(isLiteralTarget);
  return `Safer: move it to the trash instead — mv ${literal ? operands.map(shown).join(" ") : "<path>"} ~/.Trash/ (allowed, no code needed).`;
}

/**
 * The same prompt with the trash hint appended when it is the `rm` DELETE ask;
 * any other prompt is returned unchanged (same object).
 * @param prompt - The prompt the guards returned.
 * @param command - The command it is about.
 */
export function withTrashHint(prompt: Prompt, command: string): Prompt {
  return prompt.reason.includes(RM_ASK) ? { ...prompt, reason: `${prompt.reason}\n${trashHint(command)}` } : prompt;
}

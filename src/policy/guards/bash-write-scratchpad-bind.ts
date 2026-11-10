import { accessSync, constants, statSync } from "node:fs";
import type { Statement } from "./bash-write-scratchpad-words";

/** `cd <literal absolute path>` and nothing else: no option, redirect, quote, variable, glob or tilde. */
const CD_LITERAL = /^[ \t]*cd[ \t]+(\/[A-Za-z0-9_.\-/]*)[ \t]*$/;
/** Characters that, last before a newline, leave the next line part of the same and-or list or pipeline (or a redirect/continuation). */
const OPEN_ENDING = /[&|<>\\]/;

/**
 * True when the statement starting at `from` runs unconditionally: it is at
 * the command start, or the last non-blank character before it (across any
 * run of spaces, tabs and newlines) is a `;`, or the blank run holds a newline
 * and that character is not an operator (`&`, `|`, `<`, `>`, `\`). A line that
 * ends in `&&`, `||`, `|`, `|&` or a continuation makes the next line
 * conditional, so it is not accepted.
 * @param cmd - Full raw command.
 * @param from - Offset of the statement's first non-blank character.
 * @returns True when no operator can skip the statement.
 */
export function startsUnconditionally(cmd: string, from: number): boolean {
  let at = from - 1;
  let newline = false;
  while (at >= 0 && (cmd[at] === " " || cmd[at] === "\t" || cmd[at] === "\n")) {
    newline ||= cmd[at] === "\n";
    at--;
  }
  if (at < 0) return true;
  const last = cmd[at] ?? "";
  return last === ";" || (newline && !OPEN_ENDING.test(last));
}

/** Offset of the first non-blank character of a statement. */
function firstWord(s: Statement): number {
  return s.start + (s.text.length - s.text.trimStart().length);
}

/** True when `path` is an existing directory the user can enter, now (hook time). */
function isEnterableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the `S=` statement `statements[index]` executed before anything that
 * follows it? Yes when it starts unconditionally (`startsUnconditionally`), or
 * when it follows `&&` and the left side is exactly one statement
 * `cd <literal absolute dir>` that itself starts unconditionally and names a
 * directory that exists and is enterable at hook time (the owner's
 * `cd <dir> && S=<scratchpad>;` form). Residual, not modelled: the directory
 * vanishes between hook and run, or the user defined a `cd` function.
 * @param cmd - Full raw command.
 * @param statements - Parsed statements of `cmd`.
 * @param index - Index of the binding statement.
 * @returns True only for the two accepted shapes.
 */
export function bindingIsUnconditional(cmd: string, statements: readonly Statement[], index: number): boolean {
  const bind = statements[index];
  if (bind === undefined) return false;
  if (bind.before !== "&&") return startsUnconditionally(cmd, firstWord(bind));
  const cd = statements[index - 1];
  const dir = cd === undefined ? null : CD_LITERAL.exec(cd.text)?.[1];
  return cd !== undefined && dir != null && startsUnconditionally(cmd, firstWord(cd)) && isEnterableDir(dir);
}

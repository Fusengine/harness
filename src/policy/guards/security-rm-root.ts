import type { Effective } from "../effective-segments";

/** Label of the recursive delete of the filesystem root, a home directory or a top-level system directory. */
export const RM_ROOT_LABEL = "DANGEROUS PATTERN: recursive delete of /, ~ or a top-level system directory";

/** Top-level directories whose deletion (the directory itself or `/dir/*`) is never ordinary work. */
export const TOP_DIRS: readonly string[] = ["etc", "usr", "var", "bin", "sbin", "boot", "lib", "lib64", "System", "Library", "Applications", "opt", "private", "Users", "home", "root", "dev", "proc", "sys", "Volumes"];
/** `/`, `/.`, `/..`, `/*`, `//`, `~`, `~/`, `~/*`, `~user`, `$HOME`, `${HOME}` (with an optional trailing `/` or `/*`). */
const ROOT_LIKE = /^(?:\/+(?:\.{1,2}|\*)?\/*|~(?:[A-Za-z0-9_][A-Za-z0-9_-]*)?\/*(?:\*|\.)?|\$\{?HOME\}?\/*(?:\*|\.)?)$/;
const TOP_DIR = new RegExp(`^/+(?:${TOP_DIRS.join("|")})/*(?:\\*|\\.)?$`);
/** A home directory itself: `/Users/<name>` or `/home/<name>` (optionally `/*`). */
const HOME_DIR = /^\/+(?:Users|home)\/[^/]+\/*(?:\*)?$/;

/** True when `argv` carries a recursive flag in any spelling (`-r`, `-R`, `-rf`, `-Rf`, `--recursive`). */
function recursive(argv: readonly string[]): boolean {
  return rmOptions(argv).some((a) => a === "--recursive" || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)));
}

/**
 * Options of one `rm`: the dash words before the `--` that ends them.
 * @param argv - Arguments of the `rm` (verb excluded).
 * @returns The words starting with `-` that precede `--` (all of `argv` when there is no `--`).
 */
export function rmOptions(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).filter((a) => a.startsWith("-"));
}

/**
 * Operands of one `rm`: everything after the options (`--` ends them).
 * @param argv - Arguments of the `rm` (verb excluded).
 * @returns The non-option words, plus every word after `--`.
 */
export function rmOperands(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  const flags = end < 0 ? argv : argv.slice(0, end);
  return [...flags.filter((a) => !a.startsWith("-")), ...(end < 0 ? [] : argv.slice(end + 1))];
}

/**
 * True when `operand` (`~…` / `$…`) is quoted or escaped in `seg` so it names a literal file, not the home
 * directory: `'~'`, `"~"`, `\~`, `'$HOME'` (a double-quoted `"$HOME"` still expands). Quotes are lost in argv.
 * @param seg - The segment as written.
 * @param operand - One `rm` operand after quote resolution.
 */
export function isLiteralOperand(seg: string, operand: string): boolean {
  if (!/^~|^\$/.test(operand)) return false;
  return [`'${operand}`, `"${operand}`, `\\${operand}`].some((q) => seg.includes(q) && !(q.startsWith('"') && operand.startsWith("$")));
}

/**
 * True when a recursive `rm` the line runs targets the filesystem root, a home
 * directory or a top-level system directory, in any literal spelling (`/`, `/*`,
 * `/.`, `~/`, `$HOME`, `"$HOME"`, `~user`, `/Users`, `/System`, `/Users/me`, `-Rf`,
 * `--recursive --force`, `-- /` …). Ordinary targets (`./build`, `node_modules`,
 * `~/projects/x`, `/tmp/x`) never match.
 * @param items - Commands found by `expand`.
 */
export function rmTargetsRoot(items: readonly Effective[]): boolean {
  return items.some((i) => i.verb === "rm" && recursive(i.argv) && rmOperands(i.argv).some((o) => !isLiteralOperand(i.seg, o) && (ROOT_LIKE.test(o) || TOP_DIR.test(o) || HOME_DIR.test(o))));
}

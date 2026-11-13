import { parseOutputRedirect } from "./bash-write-redirect-op";
import { isFreshOrRegular, isPlainComponent, scratchpadDirOf, type TempRoot } from "./bash-write-scratchpad-target";
import { scratchpadVarResolves } from "./bash-write-scratchpad-var";
import { parseStatements, type Statement } from "./bash-write-scratchpad-words";

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const BOUNDARY = "(?=$|[\\s;&|<>)])";
/** Longest command (in characters) a scratchpad/temp window will inspect; longer commands keep the old verdict. */
export const MAX_LENGTH = 4096;
/** Fd duplication (`2>&1`, `>&2`, `>&-`): no file involved. */
const DUP = new RegExp(`^&(?:\\d+|-)${BOUNDARY}`);
const DEV_NULL = new RegExp(`^(["']?)/dev/null\\1${BOUNDARY}`);
/** Printable ASCII, tab and newline only: JS `\s` and the shell disagree on every other byte. */
export const PLAIN_TEXT: RegExp = /^[\x20-\x7e\t\n]*$/;
/** Comments, command/process substitution, arithmetic, heredocs and any `${` other than `${S}` hide or rebind things. */
export const OPAQUE_SYNTAX: RegExp = /#|\\|\(|`|\$\(|\$\{(?!S\})|\(\(|<<|[<>]\(|=\(/;

/**
 * Match one redirect target word at `pos`: only `<dir>/<name>`, `$S/<name>`
 * or `${S}/<name>`, optionally in one plain quote pair (single quotes never
 * around a variable), followed by a word boundary.
 * @returns The end index and whether it used the variable, or null.
 */
function matchTarget(cmd: string, pos: number, dir: string | null, temps: readonly TempRoot[]): { end: number; variable: boolean } | null {
  const forms = [...(dir === null ? [] : [{ text: dir, physical: dir, scratch: true }]), ...temps.flatMap((t) => t.names.map((text) => ({ text, physical: t.physical, scratch: false })))];
  for (const form of forms) {
    const dirPattern = form.text.replace(ESCAPE, "\\$&");
    const alt = form.scratch ? `${dirPattern}|(\\$S|\\$\\{S\\})` : dirPattern;
    const word = new RegExp(`^(["']?)(?:${alt})/([^\\s;&|<>)"']+)\\1${BOUNDARY}`).exec(cmd.slice(pos));
    if (!word) continue;
    const [text, quote, ...rest] = word;
    const name = rest[rest.length - 1];
    const variable = form.scratch ? rest[0] : undefined;
    if (name === undefined || !isPlainComponent(name) || !isFreshOrRegular(form.physical, name)) return null;
    if (variable !== undefined && quote === "'") return null;
    return { end: pos + text.length, variable: variable !== undefined };
  }
  return null;
}

/** Operators the window accepts, as `parseOutputRedirect` spells them: `>`, `>>`, `N>`, `N>>`, `&>`, `&>>`, `>&file`. `>|`, `>>&`, `&2>` and the rest keep the old verdict. */
const OPERATOR = /^(?:\d*>{1,2}|&>{1,2}|>&)$/;

/** Walk every `>` of the command; returns the number of file redirects, whether one used `$S` and the indexes of the `&` that belong to accepted redirect operators, or null if any `>` is not a proven safe form. */
export function scanRedirects(cmd: string, dir: string | null, temps: readonly TempRoot[] = []): { files: number; variable: boolean; amps: number[] } | null {
  let files = 0;
  let variable = false;
  const amps: number[] = [];
  let at = cmd.indexOf(">");
  while (at !== -1) {
    if (["<", "}"].includes(cmd[at - 1] ?? "")) return null;
    const dup = cmd[at - 1] !== "&" && cmd[at + 1] === "&" ? DUP.exec(cmd.slice(at + 1)) : null;
    if (dup) {
      at = cmd.indexOf(">", at + 1 + dup[0].length);
      continue;
    }
    const { redirect, opEnd } = parseOutputRedirect(cmd, at, 0, cmd.length);
    if (redirect === null || !OPERATOR.test(redirect.operator) || cmd[redirect.start - 1] === "&") return null;
    if (redirect.operator.startsWith("&")) amps.push(redirect.start);
    else if (redirect.operator.endsWith("&")) amps.push(opEnd);
    let pos = opEnd + 1;
    while (cmd[pos] === " " || cmd[pos] === "\t") pos++;
    const devNull = DEV_NULL.exec(cmd.slice(pos));
    const target = devNull ? { end: pos + devNull[0].length, variable: false } : matchTarget(cmd, pos, dir, temps);
    if (target === null) return null;
    if (!devNull) files++;
    variable ||= target.variable;
    at = cmd.indexOf(">", target.end);
  }
  return { files, variable, amps };
}

/** A redirect may not follow code that could have planted a link: only a runner's own redirect (opened before it starts) is allowed. */
function orderIsSafe(statements: readonly Statement[]): boolean {
  let ranCode = false;
  let pipeline: Statement[] = [];
  const flush = (): boolean => {
    const files = pipeline.reduce((n, s) => n + s.files, 0);
    const runs = pipeline.some((s) => s.kind === "runner");
    const ok = !(files > 0 && (ranCode || (runs && pipeline.length > 1)));
    ranCode ||= runs;
    pipeline = [];
    return ok;
  };
  for (const statement of statements) {
    if (statement.before !== "|" && pipeline.length > 0 && !flush()) return false;
    pipeline.push(statement);
  }
  return flush();
}

/**
 * True only when EVERY output redirect of `cmd` provably writes one fresh or
 * regular file directly inside the session scratchpad (or `/dev/null`) AND
 * the rest of the command is a flat list of `S=` assignments, read-only
 * commands and test/build runners, with no file redirect once a runner has
 * run (a lone runner may own its redirect, opened before it starts). Anything
 * else (unknown operator or command word, substitution, comment, background
 * job, non-ASCII byte, oversized input, a redirect after code that could
 * have planted a link) returns false so the caller keeps the old verdict.
 * @param cmd - Full raw command.
 * @param scratchpadDir - `scratchpad_dir` from the host payload.
 * @returns True when the redirect window applies; false keeps the caller's old verdict.
 */
export function redirectsOnlyInScratchpad(cmd: string, scratchpadDir: unknown): boolean {
  try {
    const dir = scratchpadDirOf(scratchpadDir);
    if (dir === null || cmd.length > MAX_LENGTH || !PLAIN_TEXT.test(cmd) || OPAQUE_SYNTAX.test(cmd)) return false;
    const redirects = scanRedirects(cmd, dir);
    // Any `&` other than `&&`, a descriptor dup or a scanned redirect operator is a background job / `|&`.
    const rest = redirects === null ? cmd : redirects.amps.reduce((s, i) => `${s.slice(0, i)} ${s.slice(i + 1)}`, cmd);
    if (/&/.test(rest.replace(/&&|\d*>&(?:\d+|-)/g, ""))) return false;
    const statements = redirects === null ? null : parseStatements(cmd);
    if (redirects === null || statements === null || redirects.files === 0 || !orderIsSafe(statements)) return false;
    // Any `$S` anywhere (not only in a target) must be provably the scratchpad dir.
    return !(redirects.variable || /\$\{S\}|\$S(?![A-Za-z0-9_])/.test(cmd)) || scratchpadVarResolves(cmd, statements, dir);
  } catch {
    return false;
  }
}

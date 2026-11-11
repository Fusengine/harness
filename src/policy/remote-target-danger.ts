import { operandsAfter } from "./remote-target-payload";

/** Top-level directories whose direct children are not "a named path": a delete there needs a deeper target. */
const SYSTEM_TOP = new Set([
  "etc", "usr", "var", "bin", "sbin", "boot", "lib", "lib32", "lib64", "libx32", "dev", "proc", "sys", "root", "home",
  "Users", "private", "Volumes", "System", "Library", "Applications",
]);

/** True when a delete/chown operand is a specific, named, non-dynamic path (not `/`, `/*`, `~`, `.`, `..`, a glob, a variable, or a bare system directory). */
function namedPath(token: string, relativeOk: boolean): boolean {
  if (/[$`*?[\]{}()<>\\!]/.test(token) || token === "") return false;
  const abs = token.startsWith("/");
  const home = token === "~" || token.startsWith("~/");
  if (token.startsWith("~") && !home) return false;
  const segs = (home ? token.slice(2) : token).split("/").filter((s) => s !== "");
  if (segs.length === 0 || segs.some((s) => s === "." || s === "..")) return false;
  if (!abs) return home || relativeOk;
  return segs.length >= (SYSTEM_TOP.has(segs[0] ?? "") ? 3 : 2);
}

/** An expansion glued to letters/digits (`r$()m`, `r${x}m`, `r$E"m"`) or a backslash-newline: it can assemble a verb the scan cannot see. */
const WORD_FORMING: ReadonlyArray<RegExp> = [
  /\\\n/, /[A-Za-z0-9_][$`]/, /\$\([^()]*\)[A-Za-z0-9_]/, /\$\{[^}]*\}[A-Za-z0-9_]/, /`[^`]*`[A-Za-z0-9_]/, /\$[A-Za-z_]\w*["']/,
];

/** A word that can form a command name out of pieces (`r$()m`, `r\<newline>m`) or a command word that is itself an expansion. */
function obscuredVerb(raw: string): boolean {
  if (WORD_FORMING.some((re) => re.test(raw))) return true;
  return raw.split(/[;&|\n]+/).some((clause) => {
    const words = clause.trim().split(/\s+/);
    while (words.length > 1 && /^(?:sudo|doas|env|nohup|time|exec|command|-\S*|\w+=\S*)$/.test(words[0] ?? "")) words.shift();
    return /[$`]/.test(words[0] ?? "");
  });
}

/**
 * Whether a remote command string holds a destructive form that must keep TODAY's verdict even on a proven remote host:
 * `--no-preserve-root`, `xargs rm`, an `rm` whose operand is not a named path (`/`, `/*`, `~`, a bare system dir, a glob,
 * a variable, `..`, or a relative name after a `cd /`), a recursive `chown`/`chmod` aimed at such a path, or a command
 * name assembled from pieces. Scans every `rm` occurrence, quoted or not.
 * @param raw - The remote command text (decoded words joined by spaces).
 */
export function payloadCatastrophic(raw: string): boolean {
  if (obscuredVerb(raw)) return true;
  // Quote/backslash splitting inside the remote command (`r""m`, `\rm`) is undone first, so it cannot hide the verb.
  const payload = raw.replace(/['"\\]/g, "");
  if (/--no-preserve-root/.test(payload) || /\bxargs\b[^;&|\n]*\brm\b/.test(payload)) return true;
  // A relative operand is only "named" when every cd in the command goes to a named absolute directory.
  const relOk = [...payload.matchAll(/\b(?:cd|pushd)\s+(\S+)/g)].every((m) => /^(?:\/|~\/)/.test(m[1] ?? "") && namedPath(m[1] ?? "", false));
  const pathy = (t: string): boolean => /[/~*?$.]/.test(t);
  for (const m of payload.matchAll(/\brm\b/g)) {
    if (operandsAfter(payload, (m.index ?? 0) + 2).ops.some((t) => !namedPath(t, relOk))) return true;
  }
  for (const m of payload.matchAll(/\bch(?:own|mod)\b/g)) {
    const rest = payload.slice((m.index ?? 0) + 5);
    if (!/^\s*(?:\S+\s+)*?(?:-[a-zA-Z]*R|--recursive)\b/.test(rest.split(/[;&|\n]/)[0] ?? "")) continue;
    if (operandsAfter(payload, (m.index ?? 0) + 5).ops.filter(pathy).some((t) => !namedPath(t, relOk))) return true;
  }
  return false;
}

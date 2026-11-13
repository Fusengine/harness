const SHELLS = "(?:sh|bash|zsh|dash|ksh|ash|csh|tcsh|fish)";
/** Payload shapes that are never relaxed (decision 22:35): they can make the remote text run, or reach, something else. */
const REFUSED: ReadonlyArray<RegExp> = [
  new RegExp(`\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:env\\s+\\S+\\s+)?(?:\\S*/)?${SHELLS}(?![\\w-])`),
  new RegExp(`\\|\\s*xargs\\b[^|;&\\n]*(?<![\\w-])${SHELLS}(?![\\w-])`),
  /(?<![\w-])(?:base64|xxd)(?![\w-])|\bopenssl\b[^;&|\n]*\b(?:enc|base64)\b/,
  /\bfind\b[^;&|\n]*\s-(?:exec|execdir|ok|okdir)\b/,
  /\benv\b[^;&|\n]*\s(?:-C|--chdir)\b|--chdir\b|\bsudo\b[^;&|\n]*\s-D\b/,
  /(?<![\w-])ln\b[^;&|\n]*\s(?:-[a-zA-Z]*s|--symbolic)/,
  /(?<![\w-])eval(?![\w-])|\$\(|`/,
];
const CD = /(?<![\w-])(?:cd|pushd)(?![\w-])/;
/** Characters that make a path operand dynamic (glob, variable, substitution, tilde, escape...). */
const BAD_CHARS: RegExp = /[$`*?[\]{}()<>\\!~]/;
const MODE = /^(?:[0-7]{3,4}|[ugoa]*[-+=][rwxXst]*(?:,[ugoa]*[-+=][rwxXst]*)*)$/;
const OWNER = /^[A-Za-z0-9._-]*(?::[A-Za-z0-9._-]*)?$/;

/** A literal absolute path of at least 2 components, with no glob, variable, `~`, `.` or `..`. */
function literalAbs(t: string): boolean {
  if (!t.startsWith("/") || BAD_CHARS.test(t)) return false;
  const segs = t.split("/").filter((s) => s !== "");
  return segs.length >= 2 && !segs.some((s) => s === "." || s === "..");
}

/**
 * Operand tokens (options dropped) and option tokens of the command whose verb ends at `at`, up to the next control operator.
 * @param text - Remote command text with quotes already removed.
 * @param at - Index just after the verb.
 */
export function operandsAfter(text: string, at: number): { ops: string[]; flags: string[] } {
  const toks = (text.slice(at).split(/[;&|\n]/)[0] ?? "").split(/\s+/).filter((t) => t !== "");
  return { ops: toks.filter((t) => !t.startsWith("-")), flags: toks.filter((t) => t.startsWith("-")) };
}

/**
 * Allowlist gate for a remote command string: true only when it holds none of the refused shapes (pipe into a shell,
 * base64/xxd/openssl decode, `find -exec`, `env -C`/`--chdir`/`sudo -D`, `ln -s`, `eval`, `$(`, backticks, a `cd`
 * before a delete or recursive chown/chmod) and every `rm`, `chown -R` and `chmod -R` operand is a literal absolute
 * path with at least 2 components.
 * @param raw - The remote command text (decoded words joined by spaces).
 */
export function payloadAllowed(raw: string): boolean {
  const text = raw.replace(/['"\\]/g, "");
  if (REFUSED.some((re) => re.test(text))) return false;
  let risky = false;
  for (const m of text.matchAll(/(?<![\w-])rm(?![\w-])/g)) {
    risky = true;
    const { ops } = operandsAfter(text, (m.index ?? 0) + 2);
    if (ops.length === 0 || !ops.every(literalAbs)) return false;
  }
  for (const m of text.matchAll(/(?<![\w-])ch(own|mod)(?![\w-])/g)) {
    const { ops, flags } = operandsAfter(text, (m.index ?? 0) + 5);
    if (!flags.some((f) => /^-[a-zA-Z]*R/.test(f) || f === "--recursive")) continue;
    risky = true;
    const first = ops[0] ?? "";
    const spec = m[1] === "own" ? OWNER : MODE;
    const paths = !first.startsWith("/") && spec.test(first) ? ops.slice(1) : ops;
    if (paths.length === 0 || !paths.every(literalAbs)) return false;
  }
  return !(risky && CD.test(text));
}

import { CMD } from "./bash-command-anchor";
import { readPerlToken } from "./bash-write-perl-words";

/**
 * "perl in-place edit" rule for CODE_MUTATORS. The verdict is ae977a9's
 * ({@link LEGACY}, byte for byte) EXCEPT in exactly two cases, where the rule
 * does not fire:
 *
 *  (A) a pure-read program: one simple command (bash-write-perl-words.ts
 *      whitelist, no redirect/separator/expansion), first word exactly `perl`,
 *      switches only from `n l a F 0 w e E`, at least one `-e`/`-E` program,
 *      never `--` or a lone `-`, and NO program text containing `$^I`, `do`,
 *      `require`, `eval`, `use`, `exec`, `system`, `qx`, `readpipe`, `open`,
 *      `pipe`, `sysopen`, `rename`, `unlink`, `fork`, `syscall`, `IPC`,
 *      `INPLACE`, `print {`, a backtick or any `>`;
 *  (B) the owner's macOS timeout idiom: same command shape, the only program is
 *      exactly `[alarm N;] exec @ARGV[;]` and the child's first word is a bare
 *      agent CLI (claude, codex, kimi, cursor, cursor-agent).
 *
 * The other guards (the inline-perl `exec` ask) are untouched. Anything else —
 * `-p`, `-i`, `-M`, `-x`, `-S`, `-d`, a path, another child — is LEGACY.
 */

/** ae977a9's rule, verbatim: the single source of the legacy verdict. */
const LEGACY: RegExp = new RegExp(`${CMD}perl\\b[^|]*\\s-[pi]i?\\b`);
const FIRST_WORD_PERL = /^[ \t]*perl[ \t]/;
const FORBIDDEN =
  /\^I|\b(?:do|require|eval|use|exec|system|qx|readpipe|open|pipe|sysopen|rename|unlink|fork|syscall)\b|IPC|INPLACE|print\s*\{|`|>/;
const TIMEOUT_IDIOM = /^\s*(?:alarm\s+\d+\s*;\s*)?exec\s+@ARGV\s*;?\s*$/;
const AGENT_CLIS = new Set(["claude", "codex", "kimi", "cursor", "cursor-agent"]);

interface Cluster { ok: boolean; takesNext: boolean; isEval: boolean; attached: string }

/** Reads a switch cluster made only of `n l a F 0 w e E`; anything else is not ok. */
function readCluster(cluster: string): Cluster {
  const res = (c: Partial<Cluster>): Cluster => ({ ok: true, takesNext: false, isEval: false, attached: "", ...c });
  let k = 0;
  while (k < cluster.length) {
    const ch = cluster[k] as string;
    const rest = cluster.slice(k + 1);
    if (ch === "e" || ch === "E") return res({ isEval: true, takesNext: rest === "", attached: rest });
    if (ch === "F") return res({});
    k++;
    if (ch === "0" && cluster[k] === "x") { k++; while (/[0-9a-fA-F]/.test(cluster[k] ?? "")) k++; }
    else if (ch === "0" || ch === "l") while (/[0-7]/.test(cluster[k] ?? "")) k++;
    else if (ch !== "n" && ch !== "a" && ch !== "w") return res({ ok: false });
  }
  return res({});
}

/** Index of the first non-blank char at or after `from`. */
function skip(s: string, from: number): number {
  let i = from;
  while (s[i] === " " || s[i] === "\t") i++;
  return i;
}

/** True when every token from `from` to EOF is whitelist-certain and no word starts with `=`. */
function certainToEnd(s: string, from: number): boolean {
  let pos = from;
  for (;;) {
    const start = skip(s, pos);
    const tok = readPerlToken(s, pos);
    if (tok.uncertain || (tok.word && s[start] === "=")) return false;
    if (tok.end) return s[tok.next] === undefined;
    pos = tok.next;
  }
}

/** True for case (A) or (B): the in-place rule must not fire. */
function exempt(cmd: string): boolean {
  const head = FIRST_WORD_PERL.exec(cmd);
  if (!head || !certainToEnd(cmd, head[0].length - 1)) return false;
  let pos = head[0].length - 1;
  const programs: string[] = [];
  for (;;) {
    const start = skip(cmd, pos);
    const tok = readPerlToken(cmd, pos);
    const text = tok.word?.text ?? "";
    pos = tok.next;
    if (tok.end || !tok.word || !text.startsWith("-")) {
      if (programs.length === 0) return false;
      if (!programs.some((p) => FORBIDDEN.test(p))) return true;
      const child = readPerlToken(cmd, start).word?.text ?? "";
      return programs.length === 1 && TIMEOUT_IDIOM.test(programs[0] as string) && AGENT_CLIS.has(child);
    }
    if (text === "--" || text === "-") return false;
    const c = readCluster(text.slice(1));
    if (!c.ok) return false;
    if (c.isEval) programs.push(c.attached);
    if (!c.takesNext) continue;
    const arg = readPerlToken(cmd, pos);
    pos = arg.next;
    if (!arg.word) return false;
    programs[programs.length - 1] = arg.word.text;
  }
}

/**
 * True when the "perl in-place edit" rule fires: ae977a9's verdict, except for
 * the two exempt cases above.
 * @param cmd - Raw Bash command string.
 */
export function perlCarriesInPlace(cmd: string): boolean {
  return LEGACY.test(cmd) && !exempt(cmd);
}

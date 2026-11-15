import { bindingIsUnconditional } from "./bash-write-scratchpad-bind";
import type { Statement } from "./bash-write-scratchpad-words";

const LITERAL = /^(?:"([A-Za-z0-9_./-]+)"|'([A-Za-z0-9_./-]+)'|([A-Za-z0-9_./-]+))$/;
/** A `NAME=<plain literal>` word at the start of a statement. The name is letters and digits only: no `_`, so `BASH_ENV`, `LD_*`, `DYLD_*`, `PROMPT_COMMAND` can never qualify. */
const BIND = /(?:^|[;&\n])[ \t]*([A-Za-z][A-Za-z0-9]{0,15})=("[A-Za-z0-9_./-]+"|'[A-Za-z0-9_./-]+'|[A-Za-z0-9_./-]+)(?=$|[\s;&|])/g;
/** Variables the shell, the dynamic linker or the tools themselves read: never accepted as the scratchpad name, whatever they are bound to. */
const STEERING: ReadonlySet<string> = new Set(["PATH", "IFS", "HOME", "ENV", "SHELL", "CDPATH", "PS1", "PS2", "PS3", "PS4", "PWD", "OLDPWD", "TMPDIR", "TERM", "MAIL", "MAILPATH", "GLOBIGNORE", "FIGNORE", "TIMEFORMAT", "SHELLOPTS", "BASHOPTS", "POSIXLY", "FPATH", "EDITOR", "VISUAL", "PAGER", "LANG", "LC", "TZ", "USER", "LOGNAME", "DISPLAY", "NODE", "OPTARG", "OPTIND", "REPLY", "UID", "EUID", "PPID", "RANDOM", "SECONDS", "LINENO", "HISTFILE", "HISTSIZE", "HISTCONTROL", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYLIB", "RUBYOPT", "PERL5LIB", "PERL5OPT", "CLASSPATH", "NODEPATH"]);

/** `dir` without one trailing slash. */
const bare = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);

/**
 * Name of the variable the command binds to the scratchpad dir: the first
 * `NAME=<literal equal to dir>` word whose name is neither a shell-steering
 * variable nor contains an underscore. Only a candidate: {@link
 * scratchpadVarResolves} still proves the binding (single, unconditional,
 * before every use) and an unknown or unbound name keeps asking. Falls back to
 * the owner's `S`.
 * @param cmd - Full raw command.
 * @param dir - Canonical scratchpad dir.
 */
export function scratchpadVarName(cmd: string, dir: string): string {
  for (const m of cmd.matchAll(BIND)) {
    const name = m[1] ?? "";
    const value = LITERAL.exec(m[2] ?? "");
    const literal = value?.[1] ?? value?.[2] ?? value?.[3];
    if (literal !== undefined && bare(literal) === dir && !STEERING.has(name.toUpperCase())) return name;
  }
  return "S";
}

/**
 * Prove that `$name` / `${name}` is the scratchpad dir at every use: among all
 * statements exactly one word binds `name` (no `+=`, no prefix form), as a
 * standalone top-level statement `name=<plain literal equal to dir>` that follows
 * a start, `;` or newline and precedes `;`, `&&`, `||`, newline or the end
 * (never a pipeline member), and every use lies after it. The binding
 * must run unconditionally (`bindingIsUnconditional`): no operator or
 * continuation before it, except the owner's `cd <existing abs dir> && S=...`.
 * @param cmd - Full raw command (ASCII, already gated).
 * @param statements - Parsed statements of `cmd`.
 * @param dir - Canonical scratchpad dir.
 * @param name - Variable name from {@link scratchpadVarName} (`S` by default).
 * @returns True only when every use of the variable provably expands to `dir`.
 */
export function scratchpadVarResolves(cmd: string, statements: readonly Statement[], dir: string, name = "S"): boolean {
  const binds = new RegExp(`^${name}\\+?=`);
  const uses = new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "g");
  const binders = statements.flatMap((s) => s.words.filter((w) => binds.test(w)).map(() => s));
  const [bind] = binders;
  if (binders.length !== 1 || bind === undefined || bind.kind !== "assign" || bind.words.length !== 1) return false;
  if (!["", ";", "&&", "\n"].includes(bind.before) || !["", ";", "&&", "||", "\n"].includes(bind.after)) return false;
  if (!bindingIsUnconditional(cmd, statements, statements.indexOf(bind))) return false;
  const value = LITERAL.exec((bind.words[0] ?? "").slice(name.length + 1));
  const literal = value?.[1] ?? value?.[2] ?? value?.[3];
  if (literal === undefined || bare(literal) !== dir) return false;
  const end = bind.start + bind.text.length;
  return [...cmd.matchAll(uses)].every((use) => (use.index ?? 0) >= end);
}

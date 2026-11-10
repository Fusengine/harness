import { bindingIsUnconditional } from "./bash-write-scratchpad-bind";
import type { Statement } from "./bash-write-scratchpad-words";

/** The only variable name the window resolves is `S` (the owner's convention); any other `$NAME` target keeps asking. */
const USES = /\$\{S\}|\$S(?![A-Za-z0-9_])/g;
const LITERAL = /^(?:"([A-Za-z0-9_./-]+)"|'([A-Za-z0-9_./-]+)'|([A-Za-z0-9_./-]+))$/;

/**
 * Prove that `$S` / `${S}` is the scratchpad dir at every use: among all
 * statements exactly one word binds `S` (no `+=`, no prefix form), as a
 * standalone top-level statement `S=<plain literal equal to dir>` that follows
 * a start, `;` or newline and precedes `;`, `&&`, `||`, newline or the end
 * (never a pipeline member), and every `$S` use lies after it. The binding
 * must run unconditionally (`bindingIsUnconditional`): no operator or
 * continuation before it, except the owner's `cd <existing abs dir> && S=...`.
 * @param cmd - Full raw command (ASCII, already gated).
 * @param statements - Parsed statements of `cmd`.
 * @param dir - Canonical scratchpad dir.
 * @returns True only when every `$S` / `${S}` use provably expands to `dir`.
 */
export function scratchpadVarResolves(cmd: string, statements: readonly Statement[], dir: string): boolean {
  const binders = statements.flatMap((s) => s.words.filter((w) => /^S\+?=/.test(w)).map(() => s));
  const [bind] = binders;
  if (binders.length !== 1 || bind === undefined || bind.kind !== "assign" || bind.words.length !== 1) return false;
  if (!["", ";", "&&", "\n"].includes(bind.before) || !["", ";", "&&", "||", "\n"].includes(bind.after)) return false;
  if (!bindingIsUnconditional(cmd, statements, statements.indexOf(bind))) return false;
  const value = LITERAL.exec((bind.words[0] ?? "").slice("S=".length));
  const literal = value?.[1] ?? value?.[2] ?? value?.[3];
  if (literal === undefined || (literal.endsWith("/") ? literal.slice(0, -1) : literal) !== dir) return false;
  const end = bind.start + bind.text.length;
  return [...cmd.matchAll(USES)].every((use) => (use.index ?? 0) >= end);
}

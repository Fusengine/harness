/**
 * @module shell-pipes
 * What a pipe really carries into a bare shell (`X | sh`): only producers that provably print their words to
 * stdout are read (an allowlist); everything else feeds nothing.
 */
import { commandWords } from "./shell-words";

/**
 * True when stdout of `segment` is redirected in ANY form (`>`, `>>`, `>|`, `&>`, `>&N`, `1>&2`, `>&-`, `>&file`),
 * so nothing reaches a pipe after it. `2>&1`, `2>file` and other non-stdout descriptors leave stdout alone.
 * An unquoted `>` is read conservatively (anything unclear counts as redirected).
 * @param segment - One shell segment.
 */
export function redirectsStdout(segment: string): boolean {
  let quote = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (quote === "'") { if (ch === "'") quote = ""; continue; }
    if (ch === "\\") { i++; continue; }
    if (quote === '"') { if (ch === '"') quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch !== ">" || segment[i + 1] === "(") continue;
    let j = i - 1;
    while (j >= 0 && /\d/.test(segment[j] ?? "")) j--;
    const fd = segment.slice(j + 1, i);
    const startsWord = j < 0 || /\s/.test(segment[j] ?? "");
    if (!(startsWord && fd !== "" && fd !== "1")) return true;
  }
  return false;
}

/**
 * Shell code a piped producer prints to its stdout, for the producers that provably print their words: `echo`,
 * `printf` (format and arguments) and a here-string `cat <<< "…"`. Any other producer (`grep -q`, `test`, `ls`, a
 * program, a function) and any producer whose stdout is redirected feeds nothing.
 * @param producer - The segment on the left of the `|`.
 */
export function pipedPayloads(producer: string): string[] {
  if (redirectsStdout(producer)) return [];
  const w = commandWords(producer);
  const verb = (w[0] ?? "").split("/").pop();
  const args = w.slice(1);
  if (verb === "echo") {
    let skip = 0;
    while (skip < args.length && /^-[neE]+$/.test(args[skip] ?? "")) skip++;
    return skip < args.length ? [args.slice(skip).join(" ")] : [];
  }
  if (verb === "printf") return args;
  if (verb === "cat") return w.flatMap((a, i) => (a.startsWith("<<<") ? [a.length > 3 ? a.slice(3) : (w[i + 1] ?? "")] : []));
  return [];
}

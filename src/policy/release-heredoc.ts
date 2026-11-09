/**
 * @module release-heredoc
 * Drop heredoc BODIES that are plain data (a `gh pr create --body` text, a
 * `cat <<EOF` file content) so a release command quoted inside them is never
 * classified. A body that a shell interpreter will execute is kept: the
 * heredoc feeds `bash|sh|zsh|dash|ksh`, is piped into one on the same line,
 * or the command evals/sources. Reuses the heredoc operator/terminator
 * helpers of the Bash write lexer; an unterminated heredoc fails closed
 * (the remainder is kept and scanned).
 *
 * Known limit: a `<<` inside a quoted string is parsed as an operator
 * (quote-blind, needed for `"$(cat <<'EOF' … EOF)"`); only a deliberately
 * crafted command can exploit that.
 */
import { consumeHeredocBodies, parseHeredocOperator } from "./guards/bash-write-lexer-heredoc";

const SHELL_VERB = /(?:^|[\s;&|(`/])(?:ba|z|da|k)?sh(?=\s|$)/;
const EXECUTES = /\b(?:eval|source)\b|(?:^|[\s;&|(])\.\s+\S/;

/** True when the heredoc whose operator ends at `tokenEnd` feeds code that gets executed. */
function feedsShell(cmd: string, opAt: number, tokenEnd: number): boolean {
  const lineStart = cmd.lastIndexOf("\n", opAt) + 1;
  const before = cmd.slice(lineStart, opAt);
  const segment = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("|"), before.lastIndexOf("&"), before.lastIndexOf("(")) + 1);
  const nl = cmd.indexOf("\n", tokenEnd);
  const after = cmd.slice(tokenEnd, nl < 0 ? cmd.length : nl);
  return SHELL_VERB.test(` ${segment.trimStart()}`) || SHELL_VERB.test(after) || EXECUTES.test(cmd.slice(0, tokenEnd)) || EXECUTES.test(after);
}

/**
 * `command` with every data heredoc body removed.
 * @param command - Raw Bash command.
 */
export function stripDataHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  let out = "";
  let i = 0;
  const pending: { word: string; stripTabs: boolean; keep: boolean }[] = [];
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (ch === "<") {
      const op = parseHeredocOperator(command, i);
      if (op) {
        out += command.slice(i, op.tokenEnd);
        pending.push({ word: op.word, stripTabs: op.stripTabs, keep: feedsShell(command, i, op.tokenEnd) });
        i = op.tokenEnd;
        continue;
      }
    }
    out += ch;
    i += 1;
    if (ch !== "\n" || pending.length === 0) continue;
    for (const heredoc of pending.splice(0)) {
      const end = consumeHeredocBodies(command, i, [heredoc], null);
      if (!end.terminated) return out + command.slice(i);
      if (heredoc.keep) out += command.slice(i, end.pos);
      i = end.pos;
    }
  }
  return out;
}

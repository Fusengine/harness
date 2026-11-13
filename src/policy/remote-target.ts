import { payloadCatastrophic } from "./remote-target-danger";
import { isProvenRemoteDest } from "./remote-target-host";
import { payloadAllowed } from "./remote-target-payload";
import { scanShell } from "./remote-target-scan";
import { parseSsh } from "./remote-target-ssh";

/** Placeholder that replaces a remote command in the local view (word characters only: no pattern can match it). */
const PLACEHOLDER = "__REMOTE_COMMAND__";
/** A payload word the local shell cannot expand: adjacent single-quoted parts only, or one double-quoted part without `$`, backtick, `\` or `!`. */
const LITERAL_WORD: RegExp = /^(?:'[^']*')+$|^"[^"$`\\!]*"$/;
/** An unquoted word of plain characters: no `$`, backtick, `\`, `!`, glob, `{`, quote, leading `~` or `=`. */
const PLAIN_WORD: RegExp = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;
/** The command word: bare `ssh` or the system/Homebrew `ssh` binary by absolute path. */
const SSH_BIN = /^(?:\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/)?ssh$/;

/**
 * Whether the local shell can leave `raw` (the word's source text) exactly as written. The payload must be quoted literal text;
 * every other word may also be plain unquoted characters.
 * @param raw - Source text of the word, sliced from the command.
 * @param payload - True for the remote-command word.
 */
function literalWord(raw: string, payload: boolean): boolean {
  return LITERAL_WORD.test(raw) || (!payload && PLAIN_WORD.test(raw));
}

/**
 * The LOCAL view of a Bash command, or null (caller keeps today's verdict on the whole string).
 *
 * Allowlist by construction (decision 22:35): the ENTIRE command must be ONE simple invocation
 * `ssh [allowlisted options] host 'payload'`, optionally followed by `< localfile`, with nothing else: no pipe, `;`, `&&`,
 * `&`, newline-separated statement, assignment, redirect of output, heredoc, group or comment. The host must be
 * PROVEN remote (see {@link isProvenRemoteDest}) and the payload must pass {@link payloadAllowed} and
 * {@link payloadCatastrophic}. The view is the command with the payload words replaced by a placeholder.
 * @param command - Raw Bash command.
 */
export function remoteLocalView(command: string): string | null {
  if (!/\bssh\b/.test(command)) return null;
  const segs = scanShell(command);
  const seg = segs && segs.length === 1 ? segs[0] : undefined;
  if (!seg || seg.redirs.length > 2) return null;
  const first = seg.words[0];
  if (!first || first.dynamic || !SSH_BIN.test(first.text)) return null;
  const inv = parseSsh(seg.words);
  const head = inv?.payload[0];
  const last = inv?.payload[inv.payload.length - 1];
  if (!inv || !head || !last || !isProvenRemoteDest(inv.dest.text)) return null;
  // Exactly one payload word (so `head` and `last` are that word).
  if (inv.payload.length !== 1) return null;
  // ONE check over every token, on the RAW source text (never the parsed value): no word (ssh, options and values, host, payload, `<` target) may be expandable by the local shell.
  const tokens = [...seg.words.map((s) => ({ s, payload: s === head })), ...seg.redirs.slice(1).map((s) => ({ s, payload: false }))];
  if (!tokens.every(({ s, payload }) => literalWord(command.slice(s.start, s.end), payload))) return null;
  const op = seg.redirs[0];
  if (seg.redirs.length === 1 || (op && (command.slice(op.start, op.end) !== "<" || op.start < last.end))) return null;
  // Everything that is not a word or a redirect must be whitespace: no `;`, `|`, `&`, comment, ... outside the spans.
  const covered = [...seg.words, ...seg.redirs].sort((a, b) => b.start - a.start);
  let rest = command;
  for (const s of covered) rest = rest.slice(0, s.start) + " " + rest.slice(s.end);
  if (rest.trim() !== "") return null;
  const payload = inv.payload.map((w) => w.text).join(" ");
  if (!payloadAllowed(payload) || payloadCatastrophic(payload)) return null;
  return command.slice(0, head.start) + PLACEHOLDER + command.slice(last.end);
}

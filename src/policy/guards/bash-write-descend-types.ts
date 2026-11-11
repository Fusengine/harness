/** One shell word: raw source text, text after quote removal, and whether it carries an expansion. */
export interface WordTok {
  raw: string;
  value: string;
  /** Contains `$VAR`, `${…}`, a substitution, a backtick or an ANSI-C quote: `value` is not the final text. */
  dynamic: boolean;
  quoted: boolean;
  /** Offset of the word in the scanned source. */
  start: number;
  /** Body of the process substitution when the whole word is `<(…)` / `>(…)`. */
  proc?: string;
}

/** A here-document attached to a command. */
export interface Heredoc {
  /** Text after the first line, from the body through the terminator line (no leading newline). */
  raw: string;
  /** Body only. */
  body: string;
  quoted: boolean;
}

/** One simple command (or compound-command head) with everything the descent needs. */
export interface Unit {
  start: number;
  end: number;
  /** Words excluding redirect operators and their targets. */
  argv: WordTok[];
  redirs: WordTok[];
  heredocs: Heredoc[];
  hereStrings: WordTok[];
  /** Bodies of `$( )`, backticks, `<( )` and `>( )` found in this command. */
  subs: string[];
  /** Separator that precedes this command: `""`, `;`, `&&`, `||`, `|`, `&`, `\n`, `(`, `)`. */
  before: string;
}

/** A half-open character span `[start, end)` of the original command string. */
export interface Span {
  start: number;
  end: number;
}

/** One shell word: its source span, its decoded text, and whether the LOCAL shell expands part of it. */
export interface ShWord extends Span {
  text: string;
  dynamic: boolean;
}

/** One simple command: argv words (redirect operators/targets excluded) and the spans of its redirects. */
export interface ShSegment {
  words: ShWord[];
  redirs: Span[];
}

/** Addresses a host resolves to on this machine: `[]` = no such host, `null` = timeout or any other failure. */
export type HostResolver = (host: string) => string[] | null;

/** What the ssh client configuration says about one destination host. */
export interface ConfigTarget {
  /** True when the configuration might send the connection somewhere local/unknown, or cannot be read/evaluated. */
  unknown: boolean;
  /** First `HostName` that applies to the host (with `%h` expanded), when one is set. */
  hostName?: string;
}

/** The word being built by the shell scanner. */
export interface ScanWord {
  start: number;
  text: string;
  dynamic: boolean;
  /** Still made only of unquoted digits (a candidate redirect file-descriptor prefix such as the `2` of `2>`). */
  digits: boolean;
}

/** A parsed `ssh [options] host command...` invocation. */
export interface SshInvocation {
  /** The destination word as typed (`user@host` or `host`). */
  dest: ShWord;
  /** The words forming the remote command (empty when none was given). */
  payload: ShWord[];
}

/**
 * @module lead-guards/markers
 * The single constants file of the two lead guards: env switches, the structural markers of the Stop
 * guard, and the header / quote syntax of the scope guard. Nothing else in the repo defines these patterns.
 *
 * Language independence: NO natural-language word decides anything here. The Stop guard looks only at
 * structure (URL, hash, PR number, file path, ratio / percentage / unit, exit code, version, table, check symbol,
 * figures, fenced block, quoted phrase, any question mark of any script, a line-ending `;`, list /
 * multi-sentence / long-body report shape); the scope
 * guard looks only at quotation marks and Unicode-normalized text. The only words are protocol tokens, not detection of a
 * spoken language: the fixed English brief headers of the lead template (`OWNER RULES`, `WRITE`, ...), the technical
 * tokens `PR`, `exit`, `ms`/`sec`/`min`/`px`/`KB`, and the host-generated English prefixes of {@link NON_OWNER_PREFIX_RE}.
 */

/** Env switches. Both guards are ON unless the variable is exactly `"0"` (same convention as the other harness gates). */
export const LEAD_GUARD_ENV: { readonly outcome: string; readonly scope: string } = {
  outcome: "FUSE_LEAD_OUTCOME_GUARD",
  scope: "FUSE_LEAD_SCOPE_GUARD",
};

/** Reason handed to the lead when the outcome guard bounces a status-only relay (instruction to the model, not a detector). */
export const OUTCOME_BLOCK_REASON: string =
  "Status-only relay blocked (owner rule: report outcomes only). Say an outcome (link, commit hash, PR number, file, numbers, version, table) " +
  "or ask the owner a question / give the command to type. If there is nothing to report yet, end the turn with one very short word, in the owner's language.";

/** Relays are short: a longer message without a marker is a report, never blocked. */
export const RELAY_MAX_CHARS = 700;

/** Below this length a message is an acknowledgement or a stand-by word, never a relay narrative. */
export const RELAY_MIN_CHARS = 16;

const FILE_EXT = "ts|tsx|js|mjs|cjs|json|jsonc|md|mdx|toml|yaml|yml|sh|swift|py|rs|go|txt|png|jpg|mp4|log|html|css";

/** A bullet or numbered line: a message with this many is a structured report, not a one-line relay. */
export const LIST_ITEM_RE: RegExp = /^\s*(?:[-*•・]|\p{Nd}+[.)])\s+\S/gmu;
/** Minimum {@link LIST_ITEM_RE} lines for the `list` report-shape marker. */
export const REPORT_MIN_LIST_ITEMS = 2;

/** Sentence end of any script (`.!?` before a space or the end, or the CJK full stops); a message with this many sentences is a report. */
export const SENTENCE_END_RE: RegExp = /[。！？]|[.!?؟।…](?=\s|$)/gu;
/** Minimum {@link SENTENCE_END_RE} matches for the `multi-sentence` report-shape marker. */
export const REPORT_MIN_SENTENCES = 4;

/** Markdown link targets that are in-page anchors (`](#local_<hex>)`) carry no evidence: removed before matching. */
export const ANCHOR_TARGET_RE: RegExp = /\]\(#[^)]*\)/g;

/** Fenced code blocks: removed with the inline code spans before measuring the prose length. */
export const FENCED_BLOCK_RE: RegExp = /```[\s\S]*?(?:```|$)/g;

/**
 * A message with at least this much prose (outside code spans and fenced blocks) is a report, not a relay.
 * Measured on the real lead transcript: the longest stand-by relay is 211 characters, the shortest real
 * completion report 243 (prose only); 230 sits between them. A false pass is acceptable, a false block is not.
 */
export const REPORT_MIN_CHARS = 230;

/** Inline code spans: a URL inside one is an instruction ("run `x https://...`"), not a delivered result. */
export const CODE_SPAN_RE: RegExp = /`[^`\n]*`/g;

/** Structural outcome markers. `outsideCode` = matched on the text without backtick spans. */
export const OUTCOME_MARKERS: ReadonlyArray<{ name: string; re: RegExp; outsideCode?: boolean }> = [
  { name: "url", re: /https?:\/\/\S+/, outsideCode: true },
  { name: "commit-hash", re: /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/ },
  { name: "pr-number", re: /\bPR\s*#?\p{Nd}+|(?<![\w&])#\p{Nd}{1,6}(?!\p{Nd})/u },
  { name: "file-path", re: new RegExp(String.raw`(?<![\w./-])(?:[\w.~-]+/)*[\w-]+\.(?:${FILE_EXT})(?![\w])`) },
  // `(?<!\p{Nd})`: start only at a digit run's first digit (same test() result, linear instead of quadratic on long runs).
  { name: "ratio", re: /(?<!\p{Nd})\p{Nd}+\s*[/／]\s*\p{Nd}+/u },
  { name: "percent-or-unit", re: /(?<!\p{Nd})\p{Nd}+(?:[.,٫]\p{Nd}+)?\s?(?:[%％٪]|ms|sec|min|px|[KMGT]i?B)(?![\w])/u },
  { name: "exit-code", re: /\bexit(?:\s*code)?\s*[:=]?\s*\p{Nd}+/iu },
  { name: "version-tag", re: /\bv\p{Nd}+\.\p{Nd}+(?:\.\p{Nd}+)?|(?<![\p{Nd}.])\p{Nd}+\.\p{Nd}+\.\p{Nd}+/u },
  { name: "table", re: /^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|/m },
  { name: "check-symbol", re: /[✅❌✓✔✗✘]/u },
  // Figures: one number of 2+ digits in ANY script (ASCII, Arabic-Indic, Devanagari, full-width ...), outside code
  // spans and identifiers ("skills-27", "sha367", "1.40"). A false pass is acceptable, a false block is not.
  { name: "figures", re: /(?<![A-Za-z_.#\p{Nd}-])\p{Nd}{2,}(?!\p{Nd})(?![A-Za-z_-])/u, outsideCode: true },
];

/**
 * Owner-action markers: the message asks the owner something or hands a command to type. Question marks of
 * every script: any character of the Unicode question-punctuation set ANYWHERE in the message, whatever follows it
 * (`!`, an emoji, another sentence): `？ ՞ ፧ ؟ ⸮ ¿ ⁇ ⁈ ⁉ ‽ ︖ ﹖` and the Greek question mark U+037E; ASCII `?` unless
 * it is glued to a word (a URL query `a?b=1`). An ASCII `;` counts only when it ends the text or a line
 * (`trailing-semicolon`); mid-text it is an ordinary semicolon.
 */
export const OWNER_ACTION_MARKERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "question", re: /\?(?![\p{L}\p{N}_=&%#/])|[？՞፧؟⸮¿⁇⁈⁉‽︖﹖;]/u },
  { name: "fenced-command", re: /```/ },
  // An ASCII `;` is the Greek question mark (what U+037E normalizes to) only when it ends the text or a line; mid-text it is punctuation.
  { name: "trailing-semicolon", re: /[;;][ \t"'»”’)*_`]*$/mu },
  // A quoted phrase (« », “ ”, „ “, 「 」, 『 』) is the usual way to hand the owner the exact words to type.
  { name: "quoted-phrase", re: /«[^»]{3,}»|“[^”]{3,}”|„[^“”]{3,}[“”]|「[^」]{2,}」|『[^』]{2,}』/u },
];

/** Reason handed to the lead when the scope guard refuses a brief without a verifiable owner quote. */
export const SCOPE_BLOCK_REASON: string =
  "Brief refused: its OWNER RULES section must quote the owner's real words verbatim, « like this », and at least one quote must appear in a user message of this session; add the owner's actual words, never paraphrase or invent.";

/**
 * Read-only / validation helpers the lead launches as part of its own workflow (Analyze trio, sniper, challenger).
 * They do not execute the owner's mandate, so their briefs need no owner quote. Matched on the part of
 * `subagent_type` after any `plugin:` prefix.
 */
export const HELPER_AGENT_TYPES: ReadonlySet<string> = new Set(["explore-codebase", "research-expert", "sniper", "sniper-faster", "challenger", "websearch", "Explore", "Plan", "web-fetch", "claude-code-guide"]);

/**
 * Quotation marks accepted inside an OWNER RULES section, one capture group each:
 * « » (fr/es/ru/ar), “ ” and " " (en/zh/ar), „ “ (de), 「 」 and 『 』 (ja/zh), ‹ ›.
 */
export const QUOTE_RE: RegExp = /«([^»]+)»|“([^”]+)”|"([^"\n]+)"|„([^“”"]+)[“”"]|「([^」]+)」|『([^』]+)』|‹([^›]+)›/g;

/** Shortest accepted quote, in Unicode code points after normalization (shorter ones match any message by chance). */
export const MIN_QUOTE_CHARS = 3;

/** Longest stretch of a brief scanned for quotes after the OWNER RULES header. */
export const OWNER_SECTION_MAX_CHARS = 3000;

/** The OWNER RULES header, tolerant of case, runs of whitespace (incl. no-break space) and `_` / `-` separators, so a respelled header never hides a mandate from the guard. */
export const OWNER_HEADER_RE: RegExp = /OWNER[\s_-]+RULES/i;

/** The start of the next fixed header after OWNER RULES (line start, `/ HEADER` listing, or `HEADER:` / `HEADER (` inline). */
export const NEXT_HEADER_RE: RegExp =
  /(?:^|\n)[ \t]*[#*_ \t]*(?:WRITE|OUTPUT|TOOLS|PROOF|NON-GOALS|TEAM|LANGUAGE|REPORT)\b|\/[ \t]*(?:WRITE|OUTPUT|TOOLS|PROOF|NON-GOALS|TEAM|LANGUAGE|REPORT)\b|[ \t](?:WRITE|OUTPUT|PROOF|NON-GOALS|TEAM|LANGUAGE|REPORT)[ \t]*[:(]/;

/**
 * System-injected user turns: any hyphenated envelope tag (`<system-reminder>`, `<task-notification>`,
 * `<side-sessions-event>`, `<bash-input>`, `<local-command-...>`), host-generated English relays and
 * compaction summaries. A human paste (`<pasted_content>`, underscore) is NOT one.
 */
export const NON_OWNER_PREFIX_RE: RegExp = /^\s*<[a-z]+(?:-[a-z]+)+\b|^(?:Another Claude session|This session is being continued)/;

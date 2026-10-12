import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { hasSafeWriteTarget, isSafeCommandTarget, isSafeWritePath } from "./bash-write-safe-paths";
import { shellOutputRedirects } from "./bash-write-redirects";
import { unquotedShellText } from "./bash-write-unquoted";
import {
  ASK_WRITERS, CODE_COMMAND_WRITE, CODE_FILE_LITERAL, CODE_MUTATORS, INLINE_JS_ANCHOR, INLINE_JS_STDIN_ANCHOR,
  JS_RUNTIME_WRITES, NODE_WRITES, PERL_E_ANCHOR, PERL_WRITES, PYTHON_C_ANCHOR, PYTHON_WRITES, RUBY_E_ANCHOR,
  RUBY_WRITES, SAFE_PREFIXES, SESSION_STATE_FRAGMENT,
} from "./bash-write-patterns";

export { ASK_WRITERS, CODE_MUTATORS, CODE_REDIRECT, FILE_REDIRECT, SAFE_PREFIXES, SESSION_STATE_FRAGMENT } from "./bash-write-patterns";

function blockCodeWrite(reason: string): Prompt {
  return { kind: "block", title: "Bash write to code file", reason, actions: ["Use the Write/Edit tool instead"] };
}
function askFileWrite(reason: string, ruleId = "bash-write:file-write"): Prompt {
  return { kind: "ask", ruleId, title: "Bash file write", reason, actions: ["Use the Write/Edit tool instead"] };
}

/**
 * Shared block/ask/allow verdict for an inline-script write-API match, used by
 * every inline-runtime branch (JS/TS `-e`/stdin, Ruby, Perl). Bypass #2
 * closure: the code-file check runs BEFORE the safe-path check — the old
 * order let an EARLIER safe-path literal in the same script
 * (`appendFileSync("~/.fuse-harness/cache/a.json")`) short-circuit to allow
 * before a LATER code-file write (`writeFileSync("src/x.ts")`) was ever
 * inspected. Checking {@link CODE_FILE_LITERAL} first closes that disarm.
 * @param cmd - Full raw command string (heredoc/piped body included).
 * @param label - Human-readable script kind for the block/ask reason.
 */
function inlineScriptVerdict(cmd: string, label: string): Prompt | null {
  if (CODE_FILE_LITERAL.test(cmd)) {
    return blockCodeWrite(`${label} writes a code file — Use Write/Edit tools (enforces APEX + SOLID specs)`);
  }
  if (hasSafeWriteTarget(cmd)) return null;
  return askFileWrite(`${label} write operation detected. Authorize?`);
}

/**
 * Blocks shell commands that mutate code files in place (and heredocs/redirects
 * to source files); asks before other file-writing shell commands unless the
 * target is a harness-owned safe path. Forces use of the Write/Edit tool so
 * APEX/SOLID checks are not bypassed.
 *
 * The code-write detectors (CODE_MUTATORS, CODE_COMMAND_WRITE,
 * PYTHON_C_ANCHOR+PYTHON_WRITES, INLINE_JS_ANCHOR/INLINE_JS_STDIN_ANCHOR+
 * JS_RUNTIME_WRITES, the RUBY_E_ANCHOR and PERL_E_ANCHOR detectors) run BEFORE the
 * SAFE_PREFIXES short-circuit: they are command-position anchored
 * (bash-command-anchor.ts), so a transparent wrapper (`env sed -i src/x.ts`,
 * `timeout 5 patch`, `cp a b; tee src/y.ts`, `env bun -e
 * '...writeFileSync("a.ts", ...)'`, `BUN_X=1 bun -e ...`) can no longer
 * smuggle a code write past its safe first token, while a quoted mention
 * (`git commit -m "fix sed -i"`) still falls through. The short-circuit
 * becomes the terminal allow — "first token never writes, nothing above
 * matched".
 *
 * The four inline-script anchors (INLINE_JS_ANCHOR, INLINE_JS_STDIN_ANCHOR,
 * RUBY_E_ANCHOR, PERL_E_ANCHOR) are tested on `unquoted` (cmd with quoted
 * segment content stripped, {@link unquotedShellText}), not on `cmd` itself: their
 * shared {@link CMD} prefix's `[\n;&|(]` alternation matches any occurrence
 * of those characters regardless of quoting, so a separator INSIDE a quoted
 * argument (`git commit -m "…; ruby -e File.write …"`, `rg "; node -e
 * writeFileSync .*\.ts"`) used to read as a real command position and fire
 * on a pure mention. The write-API patterns (JS_RUNTIME_WRITES, RUBY_WRITES,
 * PERL_WRITES) and CODE_FILE_LITERAL keep testing the FULL `cmd` unchanged —
 * for a genuine inline invocation the script body lives inside the quotes,
 * so scanning the unquoted skeleton for write APIs would blind the detector
 * to every real case it exists to catch.
 *
 * `unquoted` additionally blanks heredoc BODY lines and shell comments
 * ({@link unquotedShellText}): a heredoc body or a trailing `#` comment is
 * DATA, never a real command position — those leaked into the anchors the
 * same way a quoted mention did.
 */
export function bashWriteGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  const cmd: string = ctx.command;
  const stripped = cmd.trim();
  const unquoted = unquotedShellText(cmd);
  const redirects = shellOutputRedirects(cmd).filter((redirect) => redirect.target !== "/dev/null");

  const mutator = CODE_MUTATORS.find((m) => (m.matches ? m.matches(cmd) : m.re.test(cmd)));
  if (mutator) return blockCodeWrite(`${mutator.desc} — Use Edit/Write tools instead`);
  if (CODE_COMMAND_WRITE.test(cmd)) return blockCodeWrite("tee/dd into a code file — Use Edit/Write tools instead");
  if (PYTHON_C_ANCHOR.test(cmd) && PYTHON_WRITES.test(cmd)) {
    return blockCodeWrite("Python inline script mutates files/spawns a process — Use Edit/Write tools instead");
  }
  if ((INLINE_JS_ANCHOR.test(unquoted) || INLINE_JS_STDIN_ANCHOR.test(unquoted)) && JS_RUNTIME_WRITES.test(cmd)) {
    return inlineScriptVerdict(cmd, "Inline JS/TS script");
  }
  if (RUBY_E_ANCHOR.test(unquoted) && RUBY_WRITES.test(cmd)) {
    return inlineScriptVerdict(cmd, "Inline Ruby script");
  }
  if (PERL_E_ANCHOR.test(unquoted) && PERL_WRITES.test(cmd)) {
    return inlineScriptVerdict(cmd, "Inline Perl script");
  }
  // Ruby/Perl piped via stdin (`ruby - <<'EOF' … EOF`, `perl - <<'EOF' …`):
  // INLINE_JS_STDIN_ANCHOR now also anchors `ruby -`/`perl -` (name kept,
  // see its JSDoc), gated here on RUBY_WRITES/PERL_WRITES instead of
  // JS_RUNTIME_WRITES so it never re-fires a command already handled above.
  if (INLINE_JS_STDIN_ANCHOR.test(unquoted) && !JS_RUNTIME_WRITES.test(cmd)) {
    if (RUBY_WRITES.test(cmd)) return inlineScriptVerdict(cmd, "Inline Ruby script");
    if (PERL_WRITES.test(cmd)) return inlineScriptVerdict(cmd, "Inline Perl script");
  }

  if (SAFE_PREFIXES.some((p) => stripped.startsWith(p)) && redirects.length === 0) {
    return null;
  }

  if (cmd.includes(SESSION_STATE_FRAGMENT)) {
    return {
      kind: "block",
      title: "Session-state tampering",
      reason: "Bash access to the harness session-state directory is a hook-bypass vector — the freshness/APEX enforcement reads it to decide block/allow.",
      actions: ["Never read or write session state from the shell"],
    };
  }

  if (redirects.length > 0) {
    if (isSafeWritePath(cmd)) return null;
    return redirects.some((redirect) => CODE_FILE_LITERAL.test(redirect.target))
      ? blockCodeWrite("Bash redirect to code file — Use Write/Edit tools (enforces APEX + SOLID specs)")
      : askFileWrite("Shell redirect to file detected. Authorize?", "bash-write:file-redirect");
  }

  // Unanchored ask-tier fallback (restored verbatim from main, Break 3 fix,
  // 2026-09-05 owner-measured parity gap): the anchored detectors above
  // (INLINE_JS_ANCHOR/RUBY_E_ANCHOR) only recognize a fixed set of transparent
  // wrappers (bash-command-anchor.ts's WRAP list) — they never fire on a
  // deeper nested invocation (`docker run … node -e …`, `ssh host "node -e
  // …"`). Those nested forms lost their ask tier when the anchored detectors
  // replaced this pair; restoring it here (unchanged position — after
  // SESSION_STATE/redirect handling, before ASK_WRITERS) closes that gap
  // without weakening anything: it only ever ADDS an ask, and only when
  // nothing above already matched (SAFE_PREFIXES already returned null for
  // `git`/`rg`/etc. quoted mentions before this line is ever reached).
  if (/\bnode\s+-e\b/.test(cmd) && NODE_WRITES.test(cmd)) {
    return hasSafeWriteTarget(cmd) ? null : askFileWrite("Node.js write operation detected. Authorize?");
  }
  if (/\bruby\s+-e\b/.test(cmd) && RUBY_WRITES.test(cmd)) return askFileWrite("Ruby write operation detected. Authorize?");

  const asker = ASK_WRITERS.find((a) => a.re.test(cmd));
  if (asker) {
    return isSafeCommandTarget(cmd) ? null : askFileWrite(`${asker.desc} detected. Authorize?`);
  }
  return null;
}

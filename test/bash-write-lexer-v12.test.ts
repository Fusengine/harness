import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { anchorText } from "../src/policy/guards/bash-write-lexer";
import { unquotedShellText } from "../src/policy/guards/bash-write-unquoted";
import type { GuardContext } from "../src/policy/guards/context";
import { REAL_CWD } from "./helpers/real-cwd";

/**
 * v12 coverage for three challenger-found defects in {@link anchorText}
 * (bash-write-lexer.ts) and its heredoc delimiter parser
 * (bash-write-lexer-heredoc.ts), each verified by real bash writing the
 * target file while the guard allowed:
 *
 * 1. Comment word-start decided on the EMITTED `out` buffer, not the raw
 *    input — `$((...))` emits a space and a backslash escape emits
 *    nothing, so a `#` right after either was misread as a comment start.
 * 2. A heredoc delimiter with embedded quotes (`<<E"O"F`) was not
 *    POSIX-quote-removed, so the parsed WORD kept literal quote chars and
 *    never matched a real `EOF` terminator line.
 * 3. An unterminated heredoc used to fall back to re-lexing the remainder,
 *    letting a body line shaped like `<<Z` open a FAKE heredoc that erased
 *    a later real write between it and a coincidentally matching `Z` line.
 */
const cmd = (command: string): GuardContext => ({ tool: "Bash", command, cwd: REAL_CWD });
type Verdict = "block" | "ask" | null;
const verdict = (command: string): Verdict => (bashWriteGuard(cmd(command))?.kind as Verdict) ?? null;
const reason = (command: string): string | undefined => bashWriteGuard(cmd(command))?.reason;

const WRITE_BUN = `bun -e 'require("fs").writeFileSync("src/x.ts","1")'`;
const WRITE_RUBY = `ruby -e 'File.write("src/x.ts","1")'`;

// --- x_ fixtures: every one MUST block, reason MUST mention Use Write/Edit -

// x_arith_hash_redirect is EXCLUDED here — see the dedicated DEVIATION test
// below, which documents why it cannot reach "block" from this task's files.
const MUST_BLOCK: Readonly<Record<string, string>> = {
  x_arith_hash_bun: `echo $((1))#; ${WRITE_BUN}`,
  x_esc_hash_bun: `echo \\a#; ${WRITE_BUN}`,
  x_esc_dollar_hash: `echo \\$#; ${WRITE_BUN}`,
  x_double_arith_hash: `echo $((1))$((2))#; ${WRITE_BUN}`,
  x_arith_hash_ruby: `echo $((1))#; ${WRITE_RUBY}`,
  x_embedded_quote_delim_fake: `cat <<E"O"F\n<<Z\n${WRITE_BUN}\nZ`,
  x_embedded_quote_delim_then_write: `cat <<E"O"F\nbody\nEOF\n${WRITE_BUN}`,
  x_unterminated_fake_inner: `cat <<EOF\n<<Z\n${WRITE_BUN}\nZ`,
  x_abc_hash_ctrl: `echo abc#; ${WRITE_BUN}`,
};

test("(x) every x_ fixture blocks with a Use Write/Edit reason", () => {
  for (const [name, command] of Object.entries(MUST_BLOCK)) {
    expect([name, verdict(command)]).toEqual([name, "block"]);
    expect([name, reason(command)]).toEqual([name, expect.stringContaining("Use Write/Edit")]);
  }
});

// Deviation (reported, not silently swallowed): x_arith_hash_redirect stays
// `null` (allow), not `block`. Root cause is OUT of this task's file
// ownership: bash-write-redirects.ts has its own, independently-implemented
// `commentStart` helper with the SAME word-start defect this task fixes in
// anchorText — it decides on the single raw character before `#` (`)` here,
// the arithmetic's own closing paren), which its `[\s;|&()]` class
// misclassifies as a real separator, so the whole `; echo 1 > src/x.ts`
// tail reads as a comment and the redirect is never found. Fixing it would
// require editing bash-write-redirects.ts, which is not in this task's
// exclusive file list (bash-write-lexer.ts, bash-write-lexer-heredoc.ts,
// this test file only) — flagged for the owner, not silently patched.
test("(x) DEVIATION: x_arith_hash_redirect stays allow — see comment above", () => {
  expect(verdict("echo $((1))#; echo 1 > src/x.ts")).toBeNull();
});

// --- d_/w_ fixtures: must equal main's measured verdict (parity) ---------

const PARITY: readonly (readonly [string, string, Verdict])[] = [
  ["d_abc_space_hash", `echo abc # ; ${WRITE_BUN}`, null],
  ["d_ls_comment", `ls -la # ; ${WRITE_RUBY}`, null],
  ["d_arr_len", "echo ${#arr[@]} $#", null],
  ["d_embedded_quote_delim_data", `cat <<E"O"F\nplan; ruby -e File.write src/x.ts\nEOF`, null],
  ["d_commit_F_short", "git commit -F- <<'EOF'\nfix; ruby -e File.write src/x.ts\nEOF", null],
  ["w_git_status", "git status", null],
  ["w_redirect_log", "echo 1 >> out.log", "block"], // literal text: Write/Edit tool instead (was ask on main)
  ["w_redirect_prog", "prog >> out.log", "ask"],
];

test("(d/w) main-parity fixtures match the hardcoded owner-measured verdict", () => {
  for (const [name, command, expected] of PARITY) {
    expect([name, verdict(command)]).toEqual([name, expected]);
  }
});

// --- anchorText unit cases -------------------------------------------------

test("(unit) arithmetic's closing paren is mid-word: '#x' after it is NOT a comment", () => {
  expect(anchorText("echo $((1))#x")).toContain("#x");
});

test("(unit) '#x' after real whitespace IS a comment and is dropped", () => {
  expect(anchorText("echo a #x")).not.toContain("#x");
});

test("(unit) an embedded-quote delimiter ('E\"O\"F') quote-removes to EOF and terminates", () => {
  const out = anchorText('cat <<E"O"F\nbody\nEOF\nnext');
  expect(out).not.toContain("body");
  expect(out).not.toContain("EOF");
  expect(out.split("\n").at(-1)).toBe("next");
});

test("(unit) an unterminated heredoc emits the raw remainder verbatim (fake inner <<Z stays visible)", () => {
  const out = anchorText("cat <<EOF\n<<Z\nbun -e x\nZ");
  expect(out).toContain("bun -e x");
});

// --- Perf -------------------------------------------------------------------

/** Deterministic pseudo-random generator (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Token alphabet exactly as specified by the mandate. */
const MALFORMED_TOKENS = ["<<", "\n", "'", '"', "$((", "`", "#", ";", "|", "bun -e ", "EOF", " ", "\\"];

function malformedTokenInput(rng: () => number, length: number): string {
  let out = "";
  while (out.length < length) out += MALFORMED_TOKENS[Math.floor(rng() * MALFORMED_TOKENS.length)];
  return out.slice(0, length);
}

test("(perf) unquotedShellText worst-case: 20 malformed 2000-char inputs stay under 5ms each", () => {
  const rng = mulberry32(2026);
  for (let i = 0; i < 20; i++) {
    const input = malformedTokenInput(rng, 2000);
    const start = performance.now();
    unquotedShellText(input);
    expect(performance.now() - start).toBeLessThan(5);
  }
});

test("(perf) 3000-line commit-body heredoc through the full guard stays under 20ms", () => {
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} of the commit message body`).join("\n");
  const start = performance.now();
  bashWriteGuard(cmd(`git commit -F- <<'EOF'\n${body}\nEOF`));
  expect(performance.now() - start).toBeLessThan(20);
});

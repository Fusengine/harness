import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { unquotedShellText } from "../src/policy/guards/bash-write-unquoted";
import type { GuardContext } from "../src/policy/guards/context";
import { REAL_CWD } from "./helpers/real-cwd";

/**
 * Owner-measured parity gap (2026-09-05, main vs working tree): the
 * inline-script command-position anchors (INLINE_JS_ANCHOR,
 * INLINE_JS_STDIN_ANCHOR, RUBY_E_ANCHOR, PERL_E_ANCHOR) were tested on
 * `stripQuoted(cmd)`, which never touches a heredoc BODY or a shell
 * COMMENT — both are DATA, never a real command position, yet a write-API
 * mention trapped inside either still fired the anchor. Fixed by testing
 * those four anchors on `unquotedShellText(cmd)` instead (bash-write.ts),
 * which additionally blanks heredoc bodies and comments before the anchors
 * ever see the text. `null` below means "no Prompt returned" (allow).
 */
const cmd = (command: string): GuardContext => ({ tool: "Bash", command, cwd: REAL_CWD });
type Verdict = "block" | "ask" | null;
const verdict = (command: string): Verdict => (bashWriteGuard(cmd(command))?.kind as Verdict) ?? null;

// --- (a) Data contexts (heredoc body / comment) match main's exact verdict ---

const DATA_TABLE: readonly (readonly [string, Verdict])[] = [
  [
    "git commit -F- <<'EOF'\nfeat(guards): anchor inline scripts\n\n"
      + 'Before: ; ruby -e File.write("src/x.ts") slipped through.\nEOF',
    null,
  ],
  ["git commit -F- <<'EOF'\nfix; ruby -e File.write src/x.ts\nEOF", null],
  [
    "cat <<'EOF' | tee /dev/null\nplan; bun -e 'require(\"fs\").writeFileSync(\"src/x.ts\",\"1\")'\nEOF",
    null,
  ],
  [`# fix ; bun -e 'require("fs").writeFileSync("src/x.ts","1")'`, null],
  [`ls -la # ; ruby -e 'File.write("src/x.ts")'`, null],
  ['ls\n# ; node -e writeFileSync("src/x.ts")', null],
  [`echo hi # | bun -e 'require("fs").writeFileSync("src/x.ts","1")'`, null],
];

test("(a) heredoc-body / comment data contexts match main's exact verdict", () => {
  for (const [command, expected] of DATA_TABLE) {
    expect(verdict(command)).toBe(expected);
  }
});

// --- (b) Real invocations still block ----------------------------------------

test("(b) bun - heredoc writing a code file still blocks", () => {
  const command = 'bun - <<\'EOF\'\nrequire("fs").writeFileSync("src/x.ts","1")\nEOF';
  expect(verdict(command)).toBe("block");
});

test("(b) ruby - heredoc writing a code file still blocks", () => {
  const command = "ruby - <<'EOF'\nFile.write(\"src/x.ts\",\"1\")\nEOF";
  expect(verdict(command)).toBe("block");
});

test("(b) bun -e anchor preceding a trailing comment still blocks", () => {
  const command = `bun -e 'require("fs").writeFileSync("src/x.ts","1")' # seed fixture`;
  expect(verdict(command)).toBe("block");
});

test("(b) heredoc redirected into a code file still blocks", () => {
  expect(verdict("cat <<'EOF' > a.ts\nx\nEOF")).toBe("block");
});

test("(b) $(...) command substitution hiding a bun write still blocks", () => {
  expect(verdict(`echo "$(bun -e 'require("fs").writeFileSync("src/x.ts","1")')"`)).toBe("block");
});

test("(b) separator OUTSIDE quotes (git add . && bun -e ...) still blocks", () => {
  expect(verdict(`git add . && bun -e 'require("fs").writeFileSync("src/x.ts","1")'`)).toBe("block");
});

// --- (c) unquotedShellText unit cases -----------------------------------------

test("(c) unquotedShellText removes the heredoc body entirely, keeps trailing text", () => {
  // Break-2 fix (2026-09-05): the body+terminator lines are REMOVED, not
  // blanked in place — line numbers carry no meaning to the anchors, and
  // blanking produced long `\n` runs that made CMD's prefix quadratic.
  const out = unquotedShellText("cat <<'EOF' | x\nbody; bun -e\nEOF\nnext");
  expect(out).not.toContain("bun -e");
  expect(out).not.toContain("body");
  const lines = out.split("\n");
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe("next");
});

test("(c) unquotedShellText never treats ${#arr} or $# as a comment", () => {
  expect(unquotedShellText("echo ${#arr} $# ok")).toBe("echo ${#arr} $# ok");
});

test("(c) unquotedShellText leaves a real trailing comment stripped", () => {
  expect(unquotedShellText("echo hi # bun -e writeFileSync")).toBe("echo hi ");
});

test("(c) unquotedShellText does not treat <<< here-string as a heredoc", () => {
  const command = "cat <<< 'foo; bun -e writeFileSync(\"src/x.ts\")'";
  const out = unquotedShellText(command);
  // The here-string content is data subject only to quote-stripping, never
  // heredoc-body blanking: the line is untouched apart from quote removal.
  expect(out).toBe(`cat <<< ''`);
});

// --- (d) Parity witnesses ------------------------------------------------------

test("(d) git status still allows", () => {
  expect(verdict("git status")).toBeNull();
});

test("(d) ls -la with trailing comment still allows", () => {
  expect(verdict("ls -la # list")).toBeNull();
});

test("(d) bun test still allows", () => {
  expect(verdict("bun test")).toBeNull();
});

test("(d) literal append redirect to a non-code file blocks (was ask: Write/Edit tool instead)", () => {
  expect(verdict("echo 1 >> out.log")).toBe("block");
  expect(verdict("prog >> out.log")).toBe("ask");
});

test("(d) redirect to a code file still blocks", () => {
  expect(verdict("echo 1 > a.ts")).toBe("block");
});

// --- (e) Timing: guard survives malformed 2000-char inputs, linear time ------

/** Deterministic pseudo-random generator (mulberry32) — no external dep, and
 *  repeatable across runs so a flaky timing test never hides a real
 *  regression behind a lucky seed. */
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

const MALFORMED_ALPHABET = "abcXYZ 01;&|()<>'\"`\n\t#$-";

function malformedInput(rng: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += MALFORMED_ALPHABET[Math.floor(rng() * MALFORMED_ALPHABET.length)];
  }
  return out;
}

test("(e) guard stays under 5ms on 20 malformed 2000-char unbalanced quote/heredoc inputs", () => {
  const rng = mulberry32(42);
  let max = 0;
  for (let i = 0; i < 20; i++) {
    const command = malformedInput(rng, 2000);
    const start = performance.now();
    bashWriteGuard(cmd(command));
    const elapsed = performance.now() - start;
    max = Math.max(max, elapsed);
    expect(elapsed).toBeLessThan(5);
  }
  console.log(`(e) max guard time over 20 malformed 2000-char inputs: ${max.toFixed(3)}ms`);
});

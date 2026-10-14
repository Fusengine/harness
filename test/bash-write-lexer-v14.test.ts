import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { anchorText } from "../src/policy/guards/bash-write-lexer";
import { unquotedShellText } from "../src/policy/guards/bash-write-unquoted";
import type { GuardContext } from "../src/policy/guards/context";

/**
 * v14 coverage for the heredoc-inside-substitution defect in
 * {@link anchorText} (bash-write-lexer.ts / bash-write-lexer-subst.ts): a
 * `$(...)`/backtick body found INSIDE a double quote (`consumeQuoted`), or
 * a bare top-level backtick, used to be copied VERBATIM — so a heredoc
 * BODY nested there (`"$(cat <<'EOF' … EOF )"`, real Claude Code commit
 * form) was never removed and read as live command text, false-BLOCKing an
 * allowed commit. Fixed by recursively lexing a substitution's interior
 * with the SAME machine (bash-write-lexer-subst.ts), depth-bounded.
 */
const cmd = (command: string): GuardContext => ({ tool: "Bash", command });
type Verdict = "block" | "ask" | null;
const verdict = (command: string): Verdict => (bashWriteGuard(cmd(command))?.kind as Verdict) ?? null;
const reason = (command: string): string | undefined => bashWriteGuard(cmd(command))?.reason;

// --- fixtures (measured against main-wt, see task probe) -------------------

const AMEND_HEREDOC = `git commit --amend -m "$(cat <<'EOF'\nchore: bump\n\nnode -e 'fs.writeFileSync("a.ts")' mention\nEOF\n)"`;

const D_FIXTURES: readonly (readonly [string, string, Verdict])[] = [
  ["d_commit_amend_heredoc", AMEND_HEREDOC, null],
  [
    "d_commit_body_bun_mention",
    `git commit -m "$(cat <<'EOF'\nfeat(guards): block inline writes\n\nbun -e 'require("fs").writeFileSync("src/x.ts","1")' is now denied\nEOF\n)"`,
    null,
  ],
  ["d_commit_body_ruby_mention", `git commit -m "$(cat <<'EOF'\nfix; ruby -e File.write src/x.ts\nEOF\n)"`, null],
  [
    "d_var_subst_heredoc_dq",
    `MSG="$(cat <<'EOF'\nplan: bun -e writeFileSync src/x.ts later\nEOF\n)"; echo "$MSG"`,
    null,
  ],
  // MAIN measured "ask" here (not null): the unanchored `/\bnode\s+-e\b/`
  // fallback in bash-write.ts scans RAW `cmd`, independent of anchoring —
  // it fires on both main and working regardless of this fix.
  ["d_backtick_heredoc", "MSG=`cat <<'EOF'\nnode -e 'fs.writeFileSync(\"a.ts\")' note\nEOF\n`", "ask"],
  [
    "d_commit_claude_style_plain",
    `git commit -m "$(cat <<'EOF'\nfeat(guards): block inline-script writes\n\nCloses the bun -e / node -e bypass on all targets.\nEOF\n)"`,
    null,
  ],
  ["d_commit_F_dash", "git commit -F- <<'EOF'\nfix; ruby -e File.write src/x.ts\nEOF", null],
];

const X_FIXTURES: readonly (readonly [string, string])[] = [
  [
    "x_commit_then_write",
    `git commit -m "$(cat <<'EOF'\nfeat: x\nEOF\n)" && bun -e 'require("fs").writeFileSync("src/x.ts","1")'`,
  ],
  [
    "x_subst_heredoc_piped_to_bun",
    `echo "$(cat <<'EOF' | bun -\nrequire("fs").writeFileSync("src/x.ts","1")\nEOF\n)"`,
  ],
  ["x_subst_dq_write", `echo "$(bun -e 'require("fs").writeFileSync("src/x.ts","1")')"`],
  [
    "x_subst_heredoc_then_write_inside",
    `echo "$(cat <<'EOF'\ndata\nEOF\nbun -e 'require("fs").writeFileSync("src/x.ts","1")')"`,
  ],
  ["x_bun_stdin", "bun - <<'EOF'\nrequire(\"fs\").writeFileSync(\"src/x.ts\",\"1\")\nEOF"],
];

test("(d) every d_ fixture matches main-wt's measured verdict", () => {
  for (const [name, command, expected] of D_FIXTURES) {
    expect([name, verdict(command)]).toEqual([name, expected]);
  }
});

test("(x) every x_ fixture blocks with a Use Write/Edit reason", () => {
  for (const [name, command] of X_FIXTURES) {
    expect([name, verdict(command)]).toEqual([name, "block"]);
    expect([name, reason(command)]).toEqual([name, expect.stringContaining("Use Write/Edit")]);
  }
});

test("(w) plain git status stays allow", () => {
  expect(verdict("git status")).toBeNull();
});

// --- anchorText unit cases ---------------------------------------------------

test("(unit) dquote-embedded '$(cat <<EOF ...)' heredoc body is removed: no 'node -e' leaks", () => {
  expect(anchorText(AMEND_HEREDOC)).not.toContain("node -e");
});

test("(unit) text AFTER a terminated heredoc, still inside '$(...)', is kept", () => {
  const input = `echo "$(cat <<'EOF'\ndata\nEOF\nbun -e x)"`;
  expect(anchorText(input)).toContain("bun -e x");
});

test("(unit) top-level bare backtick heredoc body is removed: no 'node -e y' leaks", () => {
  const input = "`cat <<'EOF'\nnode -e y\nEOF`";
  expect(anchorText(input)).not.toContain("node -e y");
});

test("(unit) unterminated heredoc inside '$(' fails CLOSED: raw remainder stays visible", () => {
  const input = "$(cat <<'EOF'\nnode -e z";
  expect(anchorText(input)).toContain("node -e z");
});

// --- Perf ---------------------------------------------------------------------

/** Distinct RNG name from sibling v12/v13 files (DRY-guard collision
 *  avoidance) producing the mandate's malformed-token alphabet. */
function splitmix32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const TOKEN_ALPHABET = [
  "<<", "\n", "'", '"', "$((", "$(", ")", "`", "#", ";", "|", "bun -e ", "EOF", " ", "\\",
];

function buildToken2000(rng: () => number): string {
  let out = "";
  while (out.length < 2000) out += TOKEN_ALPHABET[Math.floor(rng() * TOKEN_ALPHABET.length)];
  return out.slice(0, 2000);
}

test("(perf) unquotedShellText on 20 malformed 2000-char inputs stays under 5ms each", () => {
  const rng = splitmix32(4242);
  // Warm the JIT first (JSC tiers up after ~6 calls): the budget bounds steady-state complexity, not cold start.
  for (let w = 0; w < 10; w++) unquotedShellText(buildToken2000(splitmix32(w + 1)));
  for (let i = 0; i < 20; i++) {
    const input = buildToken2000(rng);
    // Min of 3 samples: an algorithmic blow-up is slow on every sample, a GC pause hits only one, so this keeps the steady-state complexity bound while ignoring one-off stalls.
    let best = Infinity;
    for (let s = 0; s < 3; s++) {
      const start = performance.now();
      unquotedShellText(input);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(5);
  }
});

test("(perf) a 2000-deep '$(' nesting does not throw and stays under 20ms", () => {
  const input = "$(".repeat(2000) + "true" + ")".repeat(2000);
  const start = performance.now();
  expect(() => anchorText(input)).not.toThrow();
  expect(performance.now() - start).toBeLessThan(20);
});

test("(perf) a 3000-line commit body stays under 20ms", () => {
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} of the commit message body`).join("\n");
  const command = `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  const start = performance.now();
  bashWriteGuard(cmd(command));
  expect(performance.now() - start).toBeLessThan(20);
});

import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { anchorText } from "../src/policy/guards/bash-write-lexer";
import { unquotedShellText } from "../src/policy/guards/bash-write-unquoted";
import type { GuardContext } from "../src/policy/guards/context";

/**
 * v15 coverage for the odd-apostrophe-inside-a-heredoc-BODY defect fixed by
 * making {@link anchorText}'s state machine (bash-write-lexer.ts) find a
 * `$(...)`/backtick substitution's own closing delimiter itself, in
 * `"paren"`/`"backtick"` mode, instead of pre-locating it with the old
 * quote-aware-but-heredoc-BLIND `closingCommandSubst`/`closingBacktick`
 * scanners (bash-write-quotes.ts). A lone `'` from a contraction
 * (`doesn't`/`can't`/`it's`) inside a heredoc BODY nested in a real Claude
 * Code commit form used to open a quote state in that separate scanner,
 * mis-locate the `)`, and spill the heredoc body into top-level lexing as
 * live command text — a false BLOCK on an otherwise-safe commit.
 */
const cmd = (command: string): GuardContext => ({ tool: "Bash", command });
type Verdict = "block" | "ask" | null;
const verdict = (command: string): Verdict => (bashWriteGuard(cmd(command))?.kind as Verdict) ?? null;
const reason = (command: string): string | undefined => bashWriteGuard(cmd(command))?.reason;

const WRITE_BUN = `bun -e 'require("fs").writeFileSync("src/x.ts","1")'`;
const DOESNT_NODE_MENTION = `git commit -m "$(cat <<'EOF'\nfix: doesn't block bodies\n\nnode -e 'fs.writeFileSync("src/x.ts","1")' mention is data.\nEOF\n)"`;

// --- (d) main-parity fixtures: real-shell-verified allowed commits, real
// bash/zsh/dash/ksh run every one fine — main-wt allows all of them ---------

const D_FIXTURES: readonly (readonly [string, string])[] = [
  ["d_doesnt_node_mention", DOESNT_NODE_MENTION],
  [
    "d_cant_bun_mention",
    `git commit -m "$(cat <<'EOF'\nfix: can't block bodies\n\n${WRITE_BUN} mention.\nEOF\n)"`,
  ],
  [
    "d_its_fine_node_mention",
    `git commit -m "$(cat <<'EOF'\nfix: it's fine now\n\nnode -e 'fs.writeFileSync("src/x.ts","1")' mention.\nEOF\n)"`,
  ],
  [
    "d_one_dquote_in_body",
    `git commit -m "$(cat <<'EOF'\nfix: has one " quote\n\n${WRITE_BUN} mention.\nEOF\n)"`,
  ],
  ["d_lone_backtick_in_body", "git commit -m \"$(cat <<'EOF'\nfix: has a \\` lone backtick\n\nEOF\n)\""],
  [
    "d_dollar_dparen_arith_in_body",
    `git commit -m "$(cat <<'EOF'\nfix: uses $((1+1)) arithmetic\n\n${WRITE_BUN} mention.\nEOF\n)"`,
  ],
  [
    "d_commit_F_dash_doesnt",
    `git commit -F- <<'EOF'\nfix: doesn't break\n\nnode -e 'fs.writeFileSync("src/x.ts","1")' mention.\nEOF`,
  ],
  ["d_gh_pr_create_its", `gh pr create --body "$(cat <<'EOF'\nIt's done: bun -e writeFileSync src/x.ts\nEOF\n)"`],
  ["d_msg_wont_assign", `MSG="$(cat <<'EOF'\nwon't\nEOF\n)"; echo "$MSG"`],
];

// --- (x) every x_ fixture must BLOCK: a real write hiding after/inside the
// substitution, fail-closed on unterminated ---------------------------------

const X_FIXTURES: readonly (readonly [string, string])[] = [
  ["x_write_after_heredoc_in_subst", `echo "$(cat <<'EOF'\nit's\nEOF\nbun -e 'require("fs").writeFileSync("src/x.ts","1")')"`],
  ["x_commit_then_write", `git commit -m "$(cat <<'EOF'\ndoesn't\nEOF\n)" && ${WRITE_BUN}`],
  ["x_backtick_heredoc_then_write", `X=\`cat <<'EOF'\nit's\nEOF\n\`; ${WRITE_BUN}`],
  ["x_unterminated_fail_closed", `echo "$(cat <<'EOF'\nit's\nnode -e 'require("fs").writeFileSync("src/x.ts","1")'`],
];

test("(d) every d_ fixture matches main-wt's measured verdict (null)", () => {
  for (const [name, command] of D_FIXTURES) {
    expect([name, verdict(command)]).toEqual([name, null]);
  }
});

test("(x) every x_ fixture blocks with a Use Write/Edit reason", () => {
  for (const [name, command] of X_FIXTURES) {
    expect([name, verdict(command)]).toEqual([name, "block"]);
    expect([name, reason(command)]).toEqual([name, expect.stringContaining("Use Write/Edit")]);
  }
});

// --- anchorText unit cases ---------------------------------------------------

test("(unit) first commit body's anchor text contains no 'node -e'", () => {
  expect(anchorText(DOESNT_NODE_MENTION)).not.toContain("node -e");
});

test("(unit) heredoc-in-substitution keeps a write AFTER the heredoc visible", () => {
  const input = `echo "$(cat <<'EOF'\nit's\nEOF\n)" && bun -e x`;
  expect(anchorText(input)).toContain("bun -e x");
});

// --- Perf ---------------------------------------------------------------------

/** Distinct RNG seed from sibling v12/v13/v14 files (DRY-guard collision
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
  "<<", "\n", "'", '"', "$(", ")", "$((", "`", "#", ";", "|", "bun -e ", "EOF", " ", "\\",
];

function buildToken2000(rng: () => number): string {
  let out = "";
  while (out.length < 2000) out += TOKEN_ALPHABET[Math.floor(rng() * TOKEN_ALPHABET.length)];
  return out.slice(0, 2000);
}

test("(perf) unquotedShellText on 20 malformed 2000-char inputs stays under 5ms each", () => {
  const rng = splitmix32(1515);
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

test("(perf) 500 unterminated heredocs across 50000 lines stays under 50ms", () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`cmd${i} <<'MARK${i}'`);
    for (let j = 0; j < 99; j++) lines.push(`body line ${i}-${j}`);
  }
  const input = `echo "$(${lines.join("\n")}`;
  // Warm the JIT on a small unterminated heredoc: the budget bounds complexity, not cold start.
  for (let w = 0; w < 10; w++) anchorText(`echo "$(cmd${w} <<'MARK${w}'\nbody`);
  const start = performance.now();
  expect(() => anchorText(input)).not.toThrow();
  expect(performance.now() - start).toBeLessThan(50);
});

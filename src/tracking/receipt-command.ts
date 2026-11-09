/**
 * @module receipt-command
 * Command-SHAPE rules for {@link classifyReceipt} (`./receipts`): which
 * command text is even eligible to be scored as a receipt at all, and which
 * runner (if any) it resolves to. Split out of `./receipts` to keep it under
 * the SOLID line ceiling.
 *
 * Threat model (explicit): these rules guard against FORGETTING to verify
 * and against honest shortcuts — a run whose output/exit code was
 * accidentally discarded, an informational invocation, a filtered run. They
 * are NOT a security control against an agent that deliberately fabricates
 * tool output, same caveat as the `CONFIRM` code in the README ("a guard
 * against accidental/hasty …, not a security control against an adversarial
 * agent").
 *
 * Structural rule (replaces the old `EXIT_MASK_RE` blacklist): the recognised
 * runner must be the LAST command of the line — {@link lastListSegment}
 * splits the unquoted command on `;`, `&&`, `||`, a lone job-control `&`, and
 * newline (never a bare pipe, which still carries the runner's real output
 * forward) and only the LAST segment is searched. `bun test && git commit -m
 * x` and `bun test || true` both null: the runner sits in an EARLIER segment
 * only. `cd x && bun test` and `bun test 2>&1 | tail -5` both still resolve:
 * the runner is in (or is) the last segment either way.
 */
import { unquotedShellText } from "../policy/guards/bash-write-unquoted";
import { ENV_PREFIX, WRAP, WRAP_ARG } from "../policy/guards/bash-command-anchor";
import type { RunnerSpec } from "./receipts";
import { RUNNERS } from "./receipt-runners";

/**
 * A flag/subcommand that runs zero (or an unbounded, still-running) tests, or
 * is purely INFORMATIONAL (version/help/config banner, no real job done):
 * `--collect-only`/`--co` (pytest), `--dry-run`, `--list`/`--listTests`/
 * `--list-tests` (jest/swift/dart), `--watch`/`--watchAll`/`--watch-all`
 * (bun/vitest/jest never exit), `--no-run` (cargo test), `--version`/`-V`,
 * `--help`/`-h`, `--init`/`--showConfig` (jest), `--fixtures` (pytest),
 * `-count=0` (go test), `go build -n` (dry-run). `--skip-build` (swift test)
 * is NOT here: it skips the BUILD step only, the tests still run — treating
 * it as informational was a false negative (real defect, fixed).
 *
 * `(?!=false)` excludes `--watch=false`/`--watchAll=false`/`--watch-all=false`
 * — Vitest's own config docs list `--watch=false` alongside `-w`/`--watch` as
 * an explicit CLI form (the option defaults to `true`), and Jest's
 * `--watchAll[=false]` is the documented way to force run-once mode on a
 * boolean CLI flag.
 */
export const NO_RUN_RE: RegExp =
  /(?:^|\s)--?(?:no-run|collect-only|co|watch(?:All|-all)?(?!=false)|listTests|list-tests|list|dry-run|version|V|help|h|init|showConfig|fixtures)\b|\btest:watch\b|(?:^|\s)-count=0\b|\bgo\s+build\s+-n\b/;

/** `>/dev/null` in any of its `>`/`2>`/`&>` forms — discarding a test
 *  runner's summary or a static checker's diagnostics destroys the only
 *  proof a receipt can offer, on either stream, regardless of kind. */
const DEV_NULL_RE = />\s*\/dev\/null/;

/** A single pipe (`|`, never `||`) — invalidates a STATIC-kind runner's
 *  "silence proves success" evidence (a pipe stage can reorder, truncate, or
 *  recount diagnostics before they reach the receipt). Harmless for a
 *  TEST-kind runner, whose counts come from parsing the piped-through text. */
const PIPE_RE = /(?<!\|)\|(?!\|)/;

/**
 * Any output-redirection operator that is NOT a harmless fd-duplication
 * (`2>&1`, `1>&2`, …): a bare `>`/`>>`, an fd-qualified `2>`/`2>>`, or the
 * combined `&>`/`&>>` form. A STATIC-kind runner's only proof is silence —
 * redirecting ANY stream after it, to ANY target (not just `/dev/null`),
 * destroys that proof exactly like a pipe does. Subsumes the old `>&-`
 * (fd-close) check: `(?!&\d)` only excludes a DIGIT target, so `>&-` still
 * matches this.
 */
const REDIRECT_RE = /\d*>{1,2}(?!&\d)|&>{1,2}/;

/**
 * A STDOUT-directed redirect only (`>`/`>>` with no leading fd number, or the
 * combined `&>`/`&>>` form) — a TEST-kind runner's counts live in whatever
 * the harness captured as its output; redirecting that away destroys the
 * evidence exactly like a `/dev/null` redirect does. A bare `2>` (stderr-only,
 * non-`/dev/null`) is deliberately left alone: {@link DEV_NULL_RE} already
 * covers the one case (any stream to `/dev/null`) that matters regardless of
 * which fd a given runner actually writes its summary to, and `2>&1` (fd
 * duplication, no stream lost) must stay allowed.
 */
const TEST_REDIRECT_RE = /(?<![0-9])>{1,2}(?!&\d)|&>{1,2}/;

/** Shell LIST separators this rule splits on: `;`, `&&`, `||`, a lone
 *  job-control `&` (never part of `&&`, nor a `>&`/`&>` redirect form like
 *  `2>&1`/`>&-`/`&>file` — the lookaround excludes both), or a newline. A
 *  bare pipe `|` is deliberately absent: it still delivers the runner's real
 *  output into the next stage, so it never starts a new list segment here. */
const LIST_SEP_RE = /&&|\|\||;|(?<!>)&(?!>)|\n/g;

/** The LAST shell list segment of `unquoted` (see module doc): the only
 *  segment a recognised runner is allowed to be found in. */
export function lastListSegment(unquoted: string): string {
  const parts = unquoted.split(LIST_SEP_RE);
  return (parts[parts.length - 1] ?? unquoted).trim();
}

/** Strips ANSI SGR escapes (`\x1b[...m`) and `\r` from a captured output
 *  once, before any pass/fail parser runs — a colorized `bun test` summary
 *  (`\x1b[32m 12 pass\x1b[0m`) must parse identically to a plain one. */
export function stripAnsi(output: string): string {
  return output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/** Whether output suppression makes a matched runner's evidence untrustworthy,
 *  scoped to `tail` — the text of its OWN list segment AFTER the runner
 *  match (never earlier text, which belongs to a prior command). */
function isSuppressed(tail: string, kind: "tsc" | "test"): boolean {
  if (DEV_NULL_RE.test(tail)) return true;
  return kind === "tsc" ? PIPE_RE.test(tail) || REDIRECT_RE.test(tail) : TEST_REDIRECT_RE.test(tail);
}

/**
 * Resolve `unquoted` to a recognised {@link RunnerSpec}, or `null` when it
 * matches none — including a {@link NO_RUN_RE} zero-test/informational
 * invocation, a runner that only appears in an EARLIER list segment (module
 * doc structural rule), or a runner whose own segment suppresses its output
 * after the match ({@link isSuppressed}). First matching `RUNNERS` entry
 * (table order) within the last segment wins.
 * @param unquoted - `unquotedShellText(command)` — never the raw command.
 */
export function matchRunner(unquoted: string): RunnerSpec | null {
  if (NO_RUN_RE.test(unquoted)) return null;
  const segment = lastListSegment(unquoted);
  for (const runner of RUNNERS) {
    const m = runner.cmd.exec(segment);
    if (!m) continue;
    const tail = segment.slice(m.index + m[0].length);
    return isSuppressed(tail, runner.kind) ? null : runner;
  }
  return null;
}

/**
 * `RunnerSpec.tool` names whose process IS the checker/test binary, so a hook
 * exit code is that binary's own. ALLOWLIST by design: the script launchers
 * (`npm|pnpm|yarn [run] test`, `bun run test` — tool `npm/pnpm/yarn test`) take
 * their exit from the LAST command of an opaque package.json script, and any
 * runner added later stays out until it is reviewed and listed here.
 */
const DIRECT_RUNNER_TOOLS: ReadonlySet<string> = new Set([
  "bun test", "vitest", "jest", "pytest", "go test", "cargo test", "phpunit", "pest",
  "swift test", "xcodebuild test", "dart/flutter test",
  "tsc", "mypy", "pyright", "phpstan", "go vet", "go build", "cargo check", "cargo clippy", "swift build",
]);

/**
 * True when `command` resolves (like {@link matchRunner}) to a DIRECT runner
 * ({@link DIRECT_RUNNER_TOOLS}), never a script launcher.
 * @param command - The raw Bash command line.
 */
export function isDirectRunnerCommand(command: string): boolean {
  const unquoted = unquotedShellText(command);
  const runner = matchRunner(unquoted);
  return runner !== null && DIRECT_RUNNER_TOOLS.has(runner.tool) && !viaScriptLauncher(unquoted);
}

/** Command-position head: env assignments + wrapper chain (same pieces as `RECEIPT_ANCHOR` in `./receipt-runners`). */
const ANCHOR_HEAD = new RegExp(`^\\s*${ENV_PREFIX}(?:${WRAP}\\s+(?:${WRAP_ARG}\\s+)*)*`);

/**
 * True when the runner is reached through `yarn <bin>` or `pnpm [opts] <bin>`
 * WITHOUT `exec`: both run a same-name package.json script first when one exists,
 * so the exit code is that script's. Conservative on purpose — `pnpm exec` only
 * counts after unambiguous options (`--long=value`, `-s|--silent|-r|--recursive`):
 * `pnpm -C exec x` (option VALUE "exec") and `--filter api exec x` are refused.
 * `npx`, `bunx`, `pnpm exec`, `uv run`, `python -m`, `vendor/bin/` and bare
 * binaries are not launchers.
 * @param unquoted - `unquotedShellText(command)`.
 */
function viaScriptLauncher(unquoted: string): boolean {
  const rest = lastListSegment(unquoted).replace(ANCHOR_HEAD, "");
  if (/^yarn\s/.test(rest)) return true;
  return /^pnpm\s/.test(rest) && !/^pnpm\s+(?:--[\w-]+=\S+\s+|(?:-s|--silent|-r|--recursive)\s+)*exec\s/.test(rest);
}

/**
 * True only when `command` is ONE simple command: no pipe, list separator
 * (`;`, `&&`, `||`), job-control `&`, subshell, command/process substitution,
 * redirection (except the harmless fd duplication `2>&1`) or newline. Checked on
 * the RAW text — no quote masking — so a quoted metacharacter is conservatively
 * "compound". Used to decide whether a hook exit code can be attributed to the
 * runner itself (a pipeline's exit code is its last stage's).
 * @param command - The raw Bash command line.
 */
export function isSingleSimpleCommand(command: string): boolean {
  return !/[|;&<>()`\n\r]|\$\(/.test(command.replace(/\d*>&\d(?=\s|$)/g, ""));
}

/**
 * @module receipt-runners
 * The ordered table of recognised verification commands (`RUNNERS`) consumed
 * by `classifyReceipt` (`./receipts`, first match wins). Every command regex
 * is {@link RECEIPT_ANCHOR}-anchored (command position: start/segment
 * separator, then any wrapper chain) plus an optional runtime {@link PREFIX}
 * (`bunx`, `npx`, `vendor/bin/`, `uv run`, `poetry run`, `python -m`, …), so a
 * real invocation matches while a quoted/argument MENTION of the same tool
 * name (`git commit -m "fix jest flake"`) never does. `classifyReceipt` tests
 * these regexes against `unquotedShellText(command)` (quote/heredoc-stripped),
 * never the raw command — matching the raw text would let a forged mention
 * hidden in a commit message or heredoc body pass as a real invocation. Spans
 * TS/JS, Python, Go, Rust, PHP, Swift, and Dart toolchains — the extension
 * list this widens on is `task-completed.ts`'s `CODE_EXTENSIONS`.
 */
import { ENV_PREFIX, WRAP, WRAP_ARG } from "../policy/guards/bash-command-anchor";
import type { RunnerSpec } from "./receipts";
import {
  parseBunTest, parseVitest, parseJest, parseNpmGeneric, parsePytest, parseGoTest,
  parseCargoTest, parseSwiftTest, parseDartTest,
} from "./receipt-runners-parse";
import { parsePhpunit, parsePest } from "./receipt-runners-parse-php";
import { parseXcodebuildTest } from "./receipt-runners-parse-xcode";
import {
  parseMypy, parsePyright, parsePhpstan, parseTsc, parseGoStatic, parseCargoStatic, parseSwiftBuild,
} from "./receipt-runners-parse-static";

/**
 * Receipt-specific command-position anchor: the same env-prefix/wrapper-chain
 * composition as `CMD` (bash-command-anchor.ts) but WITHOUT the backtick in
 * its separator class. A backtick never actually starts a new command — it
 * opens command substitution, which `unquotedShellText` already lexes and
 * re-wraps in literal backticks — so treating it as a separator here would
 * over-match a tool name sitting AFTER a real substitution
 * (`echo \`date\` mypy src`) as if it were its own invocation. The write
 * guard's `CMD` intentionally keeps the backtick (defense-in-depth: a
 * mutator hidden behind one is still caught); a verification receipt is a
 * PROOF of success, so over-matching here is unsafe, not merely redundant.
 * Real multi-line scripts stay recognised: `\n` is still a separator.
 */
const RECEIPT_ANCHOR = `(?:^|[\\n;&|(])\\s*${ENV_PREFIX}(?:${WRAP}\\s+(?:${WRAP_ARG}\\s+)*)*`;

/**
 * Runtime-option tokens tolerated between a wrapper and the tool name itself
 * (`uv run --frozen pytest`, `pnpm --filter api test`, `pnpm -r test`): each
 * iteration is one flag (`-r`, `--frozen`) with an optional space- or
 * `=`-joined value (`--filter api`, `--reporter=json`). The value clause
 * carries a mandatory `(?!-)` right after `[= ]`: without it, `\S+` can
 * swallow a FOLLOWING flag's own characters as this iteration's "value"
 * (`-o` then `-o` reinterpreted as `-o` + value `-o`), giving every adjacent
 * flag pair two indistinguishable partitions and turning the outer `*` into
 * an exponential-partition ReDoS — measured: `pnpm ` + `-o `×1500 + a
 * non-matching tail took 17.8s before this lookahead (vs <5ms after). The
 * lookahead forces a value to never itself look like the start of a new
 * flag, so each token has exactly one parse and backtracking stays linear.
 * A value that legitimately starts with `-` (e.g. `--exclude=-x`) is out of
 * scope for this best-effort recognizer — real test-runner invocations don't
 * use that shape for the options this tolerates (`--filter`, `--frozen`,
 * `--quiet`, `-r`).
 *
 * A second, independent ambiguity lived in the flag-name class itself:
 * `--?[\w-]+` let a leading dash be claimed by EITHER `--?` or by `[\w-]+`
 * (which also contains `-`) — e.g. `--flag` parses as `--?`="-" +
 * `[\w-]+`="-flag" OR `--?`="--" + `[\w-]+`="flag", two splits producing the
 * same consumed text. Across k flag tokens that is a 2^k-way split of
 * identical total input, and once the surrounding tool-name literal fails to
 * match, the engine re-explores every split — measured: `uv run ` +
 * `--flag=val `×400 + a non-matching tail took 2034ms through just the `bun
 * test` alternative alone (vs <5ms after). Fix: the flag name's FIRST
 * character must be a plain word character (`\w`, never `-`), so `--?` is
 * forced to claim every leading dash deterministically before the name
 * starts — only dashes WITHIN a multi-word flag (`--dry-run`) stay in
 * `[\w-]*`. Standard ReDoS-elimination technique (OWASP: remove
 * ambiguous/overlapping alternation so only one parse exists, same principle
 * as javascript.info's `(\w+\s?)*` → `(\w+\s)*\w*` rewrite).
 */
const OPTS = "(?:--?[\\w][\\w-]*(?:[= ](?!-)\\S+)?\\s+)*";

/**
 * Optional runtime wrapper accepted between the {@link RECEIPT_ANCHOR} and
 * the tool name itself: package-manager runners (`bunx`, `npx`, `pnpm
 * [opts] [exec]`, `yarn`), PHP's `vendor/bin/`, and Python's `uv run [opts]`
 * / `poetry run [opts]` / `python[3] -m` invocation forms (D4: `uv run
 * --frozen pytest`, `poetry run --quiet pytest`).
 */
const PREFIX = `(?:(?:\\.\\/)?vendor\\/bin\\/|bunx\\s+|npx\\s+|pnpm\\s+${OPTS}(?:exec\\s+)?|yarn\\s+|uv\\s+run\\s+${OPTS}|poetry\\s+run\\s+${OPTS}|python3?\\s+-m\\s+)?`;

/** Build an anchored command regex: {@link RECEIPT_ANCHOR} + {@link PREFIX} + a tool-specific pattern. */
function anchored(pattern: string): RegExp {
  return new RegExp(RECEIPT_ANCHOR + PREFIX + pattern);
}

/**
 * `php artisan test` — Laravel's runner is Pest-or-PHPUnit under the hood, and
 * a Pest/Collision-style project prints Pest's `Tests:  N passed (…)` summary
 * (see {@link parsePest}), not PHPUnit's `OK (N tests, …)`/`Tests: N,
 * Assertions: …` shapes. Try Pest's format FIRST; a bare `phpunit`/
 * `vendor/bin/phpunit` invocation (its own `RUNNERS` entry below) never goes
 * through here, so it keeps the plain {@link parsePhpunit} contract.
 */
function parseArtisanTest(output: string): { pass?: number; fail?: number } {
  const pest = parsePest(output);
  return pest.pass !== undefined || pest.fail !== undefined ? pest : parsePhpunit(output);
}

/**
 * `xcodebuild … test` (also `test-without-building`): `test` must sit in
 * ACTION position — after only `-flag [value]` pairs (`-scheme X`,
 * `-destination platform=macOS`) and the `clean|build|analyze|archive`
 * actions. `xcodebuild build`, `-showBuildSettings`, `build-for-testing` and
 * `-only-testing:…` therefore never match. Flag tokens are `-\S+` with at most
 * one non-dash value, so each token has a single parse (no ReDoS).
 */
const XCODEBUILD_TEST = "xcodebuild\\s+(?:-\\S+(?:\\s+(?!(?:clean|build|analyze|archive)\\s)[^-\\s]\\S*)?\\s+|(?:clean|build|analyze|archive)\\s+)*test\\b(?![:/])";

/**
 * Recognised verification commands, first match wins. `kind: "tsc"` covers
 * every static checker (the literal is historical); `kind: "test"` covers
 * every test runner.
 */
export const RUNNERS: readonly RunnerSpec[] = [
  { tool: "bun test", kind: "test", cmd: anchored("bun\\s+test\\b"), counts: parseBunTest },
  { tool: "vitest", kind: "test", cmd: anchored("vitest\\b"), counts: parseVitest },
  { tool: "jest", kind: "test", cmd: anchored("jest\\b"), counts: parseJest },
  {
    tool: "npm/pnpm/yarn test", kind: "test",
    cmd: anchored(`(?:(?:npm|pnpm|yarn)\\s+(?:run\\s+)?${OPTS}test\\b|bun\\s+run\\s+${OPTS}test\\b)`),
    counts: parseNpmGeneric,
  },
  { tool: "pytest", kind: "test", cmd: anchored("pytest\\b"), counts: parsePytest },
  { tool: "go test", kind: "test", cmd: anchored("go\\s+test\\b"), counts: parseGoTest },
  { tool: "cargo test", kind: "test", cmd: anchored("cargo\\s+test\\b"), counts: parseCargoTest },
  { tool: "phpunit", kind: "test", cmd: anchored("php\\s+artisan\\s+test\\b"), counts: parseArtisanTest },
  { tool: "phpunit", kind: "test", cmd: anchored("phpunit\\b"), counts: parsePhpunit },
  { tool: "pest", kind: "test", cmd: anchored("pest\\b"), counts: parsePest },
  { tool: "swift test", kind: "test", cmd: anchored("swift\\s+test\\b"), counts: parseSwiftTest },
  { tool: "xcodebuild test", kind: "test", cmd: anchored(XCODEBUILD_TEST), counts: parseXcodebuildTest },
  { tool: "dart/flutter test", kind: "test", cmd: anchored("(?:flutter|dart)\\s+test\\b"), counts: parseDartTest },
  { tool: "tsc", kind: "tsc", cmd: anchored("tsc\\b"), counts: parseTsc },
  { tool: "mypy", kind: "tsc", cmd: anchored("mypy\\b"), counts: parseMypy },
  { tool: "pyright", kind: "tsc", cmd: anchored("pyright\\b"), counts: parsePyright },
  { tool: "phpstan", kind: "tsc", cmd: anchored("phpstan\\s+analy[sz]e\\b"), counts: parsePhpstan },
  { tool: "go vet", kind: "tsc", cmd: anchored("go\\s+vet\\b"), counts: parseGoStatic },
  { tool: "go build", kind: "tsc", cmd: anchored("go\\s+build\\b"), counts: parseGoStatic },
  { tool: "cargo check", kind: "tsc", cmd: anchored("cargo\\s+check\\b"), counts: parseCargoStatic },
  { tool: "cargo clippy", kind: "tsc", cmd: anchored("cargo\\s+clippy\\b"), counts: parseCargoStatic },
  { tool: "swift build", kind: "tsc", cmd: anchored("swift\\s+build\\b"), counts: parseSwiftBuild },
];

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Prompt } from "../prompt/types";
import { gitCommitDir } from "./git-commit-command";

const TIMEOUT_MS = 30_000;
const ESLINT_CONFIGS: readonly string[] = [".eslintrc.json", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts"];
const PRETTIER_CONFIGS: readonly string[] = [".prettierrc", ".prettierrc.json", "prettier.config.js"];

/** Process runner (injectable so spawn failure / timeout are testable deterministically). */
export type Exec = (file: string, args: string[], opts: { cwd: string; timeout: number; stdio: ["ignore", "pipe", "pipe"] }) => unknown;

/** Outcome of one linter: failed with output, or could not run (visible warning, never a block). */
interface LintOutcome { errors: string[]; skipped: string[] }

/**
 * Run a linter. A real failure (non-zero exit) blocks; a linter that cannot run
 * (binary missing, 30 s timeout, killed) is fail-open WITH a visible warning so
 * a broken toolchain never bricks commits but is never silent either.
 */
function runLinter(exec: Exec, file: string, args: string[], label: string, cwd: string, into: LintOutcome): void {
  try {
    exec(file, args, { cwd, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: unknown) {
    const err = e as { status?: number | null; code?: string; signal?: string | null; stdout?: Buffer; stderr?: Buffer };
    if (err.status === undefined || err.status === null) {
      const why = err.code === "ETIMEDOUT" ? `timed out after ${TIMEOUT_MS / 1000}s` : err.code === "ENOENT" ? "not installed" : `did not run (${err.code ?? err.signal ?? "unknown"})`;
      into.skipped.push(`${label} ${why}`);
      return;
    }
    // Lint findings go to stdout. A non-zero exit with an EMPTY stdout (e.g. bunx cannot find the tool) is a tool that did not
    // run properly, not a finding: the long-standing verdict was allow, so it stays allow, now with a visible warning.
    const out = err.stdout?.toString().trim() ?? "";
    if (!out) {
      const hint = err.stderr?.toString().trim().split("\n")[0] ?? "";
      into.skipped.push(`${label} exited ${err.status} without findings${hint ? ` (${hint.slice(0, 120)})` : ""}`);
      return;
    }
    into.errors.push(`[${label}]\n${out}`);
  }
}

/** Run the applicable linters in `cwd`. */
function collect(exec: Exec, cwd: string): LintOutcome {
  const has = (f: string): boolean => existsSync(join(cwd, f));
  const o: LintOutcome = { errors: [], skipped: [] };
  if (has("package.json")) {
    if (ESLINT_CONFIGS.some(has)) runLinter(exec, "bunx", ["eslint", ".", "--max-warnings", "0"], "ESLint", cwd, o);
    if (has("tsconfig.json")) runLinter(exec, "bunx", ["tsc", "--noEmit"], "TypeScript", cwd, o);
    if (PRETTIER_CONFIGS.some(has)) runLinter(exec, "bunx", ["prettier", "--check", "."], "Prettier", cwd, o);
  }
  if (has("requirements.txt") || has("pyproject.toml")) runLinter(exec, "ruff", ["check", "."], "Ruff", cwd, o);
  return o;
}

/** Nearest ancestor of `dir` (itself included) holding a project manifest, so a commit from a subdirectory lints its project. */
function projectRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (["package.json", "requirements.txt", "pyproject.toml"].some((f) => existsSync(join(d, f)))) return d;
    // Never climb past the repository top: a manifest above the repo is not this commit's project.
    if (existsSync(join(d, ".git")) || dirname(d) === d) return null;
  }
}

/** Legacy trigger kept as a superset so no previously gated command is dropped. */
const legacyCommit = (c: string): boolean => c.startsWith("git") && c.includes("commit");

/**
 * Gate a `git commit` on linters (effectful: runs eslint/tsc/prettier/ruff, never auto-fixes).
 * Fires for the commit behind `cd x &&`, git global options, env prefixes, wrappers and subshells.
 * Lint failure -> `block`; a linter that could not run -> `inform` warning (fail-open, visible).
 * @param exec - Process runner (tests inject failures).
 */
export function preCommitGate(tool: string, command: string | undefined, cwd: string | undefined, exec: Exec = execFileSync): Prompt | null {
  if (tool !== "Bash" || !command || !cwd) return null;
  const dir = gitCommitDir(command, cwd) ?? (legacyCommit(command) ? cwd : null);
  if (!dir) return null;
  const { errors, skipped } = collect(exec, projectRoot(dir) ?? cwd);
  const warn = skipped.length ? `Pre-commit check skipped: ${skipped.join("; ")}.` : "";
  if (errors.length) {
    return {
      kind: "block",
      title: "Pre-commit checks failed",
      reason: `COMMIT BLOCKED — fix then retry:\n\n${errors.join("\n\n")}${warn ? `\n\n${warn}` : ""}`,
      actions: ["Fix the linter/type errors above", "Re-run the commit"],
    };
  }
  if (!warn) return null;
  return {
    kind: "inform",
    title: "Pre-commit checks skipped",
    reason: `${warn} The commit was NOT verified by that tool; run it manually.`,
    actions: ["Install or fix the tool, or run it by hand before pushing"],
    userMessage: warn,
  };
}

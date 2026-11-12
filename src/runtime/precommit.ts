import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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

/** The host payload cwd when usable (absolute and existing); a relative/missing one yields undefined so the caller falls back to the hook process cwd instead of silently disabling the gate. */
export function usableCwd(payloadCwd: string | undefined): string | undefined {
  return payloadCwd && isAbsolute(payloadCwd) && existsSync(payloadCwd) ? payloadCwd : undefined;
}

/** `git rev-parse --show-toplevel` of `dir`: a linked worktree has its OWN toplevel (never the main checkout). Null outside a repo. */
function toplevel(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"], { cwd: dir, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

const MANIFESTS: readonly string[] = ["package.json", "requirements.txt", "pyproject.toml"];
const hasManifest = (d: string): boolean => MANIFESTS.some((f) => existsSync(join(d, f)));

/**
 * Nearest ancestor of `dir` (itself included) holding a project manifest, so a commit from a subdirectory lints its project.
 * The climb is physical (realpath) and stops at the commit's own working-tree top (`git rev-parse --show-toplevel`); outside any
 * repository there is no climb at all (a stray ancestor manifest, e.g. `~/package.json`, is never a commit's project).
 */
function projectRoot(dir: string): string | null {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* keep the logical path */ }
  const top = toplevel(real);
  if (top === null) return hasManifest(real) ? real : null;
  for (let d = real; ; d = dirname(d)) {
    if (hasManifest(d)) return d;
    if (d === top || dirname(d) === d) return null;
  }
}

/**
 * Gate a `git commit` on linters (effectful: runs eslint/tsc/prettier/ruff, never auto-fixes).
 * Fires ONLY for a real `git commit` subcommand (behind `cd x &&`, git global options, env prefixes, wrappers, subshells)
 * and lints the working tree that commit lands in (a linked worktree's own toplevel, never the main checkout).
 * Lint failure -> `block`; a linter that could not run -> `inform` warning (fail-open, visible).
 * @param cwd - The session's working directory (the hook payload cwd; the hook process cwd only as a fallback).
 * @param exec - Process runner (tests inject failures).
 */
export function preCommitGate(tool: string, command: string | undefined, cwd: string | undefined, exec: Exec = execFileSync): Prompt | null {
  if (tool !== "Bash" || !command || !cwd) return null;
  // Trigger = main's legacy substring test UNION the parsed (wrapped) commits: new ⊇ old by construction, so no commit main linted is ever
  // missed. Known, documented false trigger kept on purpose (owner decision pending): read-only git that merely contains "commit"
  // (`git log --grep=commit`). The parser only decides WHICH directory is linted.
  const legacy = command.startsWith("git") && command.includes("commit");
  const dir = gitCommitDir(command, cwd) ?? (legacy ? cwd : null);
  if (!dir) return null;
  // Lint roots = the commit's own project (parsed dir: worktree toplevel, `cd x`, `-C`, `--work-tree`) UNION the session cwd's project, which is
  // what main always linted. The union (never a replacement) is what makes "everything main linted is still linted" hold even when the parsed
  // dir has a manifest with nothing to lint (`git -C sub commit`) or resolves outside the repo (`--work-tree=/tmp`).
  const roots = [...new Set([projectRoot(dir), projectRoot(cwd) ?? cwd].filter((r): r is string => r !== null))];
  const errors: string[] = [];
  const skipped: string[] = [];
  for (const root of roots) {
    const out = collect(exec, root);
    errors.push(...out.errors);
    skipped.push(...out.skipped);
  }
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

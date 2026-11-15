import { afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../../src/policy/evaluate";

/** Fixture repositories of one test file, each checked out on the branch it is named after. */
export interface GitWipRepos {
  /** Temp directory holding the repositories (itself not a git repo). */
  root: string;
  /** Non-protected branch `fix/commit-agent-no-ask`. */
  feature: string;
  main: string;
  master: string;
  develop: string;
  production: string;
  /** Detached HEAD (branch unknown). */
  detached: string;
}

/** Create a repo under `root` with one commit, checked out on `branch` (or detached when `detach`). */
function repo(root: string, name: string, branch: string, detach = false): string {
  const dir = join(root, name);
  const g = (...a: string[]): void => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" }); };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  g("commit", "-q", "--allow-empty", "-m", "init");
  if (branch !== "main") g("checkout", "-q", "-b", branch);
  if (detach) g("checkout", "-q", "--detach");
  return dir;
}

/**
 * Build the fixture repositories for the calling test file and remove them in its `afterAll`. Call it at the top level
 * of each test file: `bun test` shares one module instance across files and fires neither `exit` nor `beforeExit`, so a
 * module-level directory would either leak or be removed under the next file.
 */
export function gitWipRepos(): GitWipRepos {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-wip-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    feature: repo(root, "feature", "fix/commit-agent-no-ask"),
    main: repo(root, "main", "main"),
    master: repo(root, "master", "master"),
    develop: repo(root, "develop", "develop"),
    production: repo(root, "production", "production"),
    detached: repo(root, "detached", "feat/x", true),
  };
}

/** Policy verdict of a Bash command. */
export type Verdict = "allow" | "ask" | "block";

/**
 * Verdict of the policy for a Bash `command` run from `cwd`.
 * @param command - Raw Bash command.
 * @param cwd - Payload cwd (a fixture repo, or undefined).
 */
export function v(command: string, cwd: string | undefined): Verdict {
  const r = evaluate({ tool: "Bash", command, cwd });
  return r.decision === "allow" ? "allow" : r.prompt?.kind === "block" ? "block" : "ask";
}

import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { BRANCH_TYPES, branchNameProblem, createdBranches } from "../branch-name";
import { expand } from "../effective-segments";

/** `gh pr merge` argument that selects the squash or rebase strategy (`--squash`, `-s`, `--rebase`, `-r`, `-sd`…). */
function isSquashOrRebase(arg: string): boolean {
  if (arg.startsWith("--")) return arg === "--squash" || arg === "--rebase" || arg === "--squash=true" || arg === "--rebase=true";
  return /^-[dmsr]+$/.test(arg) && /[sr]/.test(arg);
}

/** Flags of `gh pr merge` that consume the next token (their value is never a strategy flag). */
const VALUE_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit", "-R", "--repo"]);

/** True when the `gh pr merge` arguments select squash or rebase (values of {@link VALUE_FLAGS} skipped). */
function usesSquashOrRebase(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (isSquashOrRebase(a)) return true;
  }
  return false;
}

/**
 * Owner git-flow rules, judged on every command the line really runs (wrappers
 * descended): merge strategy is "merge, never squash" (`gh pr merge --squash|-s|
 * --rebase|-r` is blocked) and new branches are named `<type>/<kebab-case>`,
 * shorter than 50 characters (`git checkout -b`, `switch -c`, `branch <name>`).
 * Names that are not literal (`$BRANCH`) cannot be judged and pass.
 * @param ctx - Guard context.
 */
export function gitFlowGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  for (const item of expand(ctx.command).items) {
    if (item.verb === "gh" && item.argv[0] === "pr" && item.argv[1] === "merge" && usesSquashOrRebase(item.argv.slice(2))) {
      return {
        kind: "block",
        ruleId: "merge-never-squash",
        title: "Merge strategy",
        reason: "Merge, never squash or rebase: the release tag points at the bump commit and a squash would orphan it.",
        actions: ["Use gh pr merge --merge --delete-branch"],
      };
    }
    if (item.verb !== "git") continue;
    for (const name of createdBranches(item.argv)) {
      const problem = branchNameProblem(name);
      if (problem) {
        return {
          kind: "block",
          ruleId: "branch-name",
          title: "Branch name",
          reason: `Branch ${problem}.`,
          actions: [`Name it <type>/<kebab-case> with type in ${BRANCH_TYPES.join(", ")}, under 50 characters (e.g. fix/fail-open-paths)`],
        };
      }
    }
  }
  return null;
}

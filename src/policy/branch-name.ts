/**
 * @module branch-name
 * Owner branch-naming rule (rule 06): `<type>/<kebab-case>`, type in the
 * fixed list, shorter than 50 characters. Also finds the branch names a
 * `git checkout -b` / `switch -c` / `branch` invocation creates.
 */

/** Allowed branch type prefixes. */
export const BRANCH_TYPES = ["feat", "fix", "chore", "docs", "refactor", "perf", "test", "ci", "build", "style"] as const;
/** Exclusive upper bound of a branch name length. */
export const BRANCH_MAX_LENGTH = 50;

const NAME = new RegExp(`^(?:${BRANCH_TYPES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`);
const DYNAMIC = /[$`*?\[{(]/;
/** `git branch` flags (any spelling, bundled short flags split) that list, delete, inspect or retarget instead of creating. */
const NOT_CREATING = new Set(["-d", "-D", "--delete", "-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-u", "--set-upstream-to", "--unset-upstream", "-v", "--verbose", "--edit-description", "-f", "--force"]);
const RENAMING = new Set(["-m", "-M", "--move", "-c", "-C", "--copy"]);
/** `git branch` long flags whose value is the next word. */
const VALUE_FLAGS = new Set(["--sort", "--format", "--abbrev", "--color", "--column", "--set-upstream-to", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);
/** Names a rename may target without following the feature-branch rule (the default branches). */
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "production"]);
const CREATE_FLAGS: Record<string, string[]> = { checkout: ["-b", "-B"], switch: ["-c", "-C", "--create", "--force-create"] };

/**
 * Why `name` breaks the naming rule, or `null` when it complies (or is not literal and cannot be judged).
 * @param name - Branch name as written on the command line.
 */
export function branchNameProblem(name: string): string | null {
  if (DYNAMIC.test(name)) return null;
  if (name.length >= BRANCH_MAX_LENGTH) return `"${name}" has ${name.length} characters (maximum ${BRANCH_MAX_LENGTH - 1})`;
  return NAME.test(name) ? null : `"${name}" does not match <type>/<kebab-case> with type in ${BRANCH_TYPES.join(", ")}`;
}

/** Flags of `git branch` arguments with bundled short flags split (`-dr` → `-d`, `-r`) and the positional words (value flags skipped). */
function branchFlags(args: readonly string[]): { flags: Set<string>; positional: string[] } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      const name = a.split("=")[0] ?? a;
      flags.add(name);
      if (VALUE_FLAGS.has(name) && !a.includes("=")) i++;
    } else if (/^-[A-Za-z]+$/.test(a)) {
      for (const c of a.slice(1)) flags.add(`-${c}`);
    } else if (!a.startsWith("-")) positional.push(a);
  }
  return { flags, positional };
}

/**
 * Branch names a git invocation creates (or renames/copies to).
 * @param argv - Subcommand first, then its arguments (`["checkout", "-b", "feat/x"]`).
 */
export function createdBranches(argv: readonly string[]): string[] {
  const [sub = "", ...args] = argv;
  const createFlags = CREATE_FLAGS[sub];
  if (createFlags) {
    return args.flatMap((a, i) => {
      const value = a.startsWith("--create=") ? a.slice(9) : createFlags.includes(a) ? args[i + 1] : undefined;
      return value !== undefined && !value.startsWith("-") && !DEFAULT_BRANCHES.has(value) ? [value] : [];
    });
  }
  if (sub !== "branch") return [];
  const { flags, positional } = branchFlags(args);
  if ([...flags].some((f) => RENAMING.has(f))) return positional.slice(-1).filter((n) => !DEFAULT_BRANCHES.has(n));
  if ([...flags].some((f) => NOT_CREATING.has(f))) return [];
  return positional.slice(0, 1);
}

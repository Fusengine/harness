/**
 * @module release-command
 * Classify a Bash command as a release step: `gh pr merge` ("merge") or a
 * tag-creating `git tag` ("tag"). Two readings, the stronger wins:
 * 1. the wrapper-aware walk (`expand`: wrappers, shell payloads, substitutions,
 *    grouping), stopped at the first release step;
 * 2. the merge-base classifier, verbatim (`baseReleaseAction`), used whenever
 *    the walk finds nothing. The result is therefore never weaker than it was
 *    before the wrapper-aware policy, by construction (budget, opaque payloads,
 *    odd quoting included).
 *
 * Decisions: `git tag` with no positional / `-l` / `--list` / `-n` /
 * `--contains` / `--points-at` / `-v` / `-d` (read or delete) is NOT a release
 * step; any create flag (`-a -s -u -m -F -f`) or a positional tag name is.
 * `gh api …/merge` is out of scope (only `gh pr merge` is gated).
 */
import { basename } from "node:path";
import { expand } from "./effective-segments";
import { gitParts, peel, type GitParts } from "./command-peel";
import { commandTokens } from "./motion/shell-verbs";
import { baseReleaseAction } from "./release-command-base";

/** The release step a command performs. */
export type ReleaseAction = "merge" | "tag";

/** `git tag` long options that create a tag. */
const TAG_CREATE_LONG = new Set(["--annotate", "--sign", "--local-user", "--message", "--file", "--force", "--edit"]);
/** `git tag` long options that list, verify or delete (read mode). */
const TAG_LIST_LONG = new Set(["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--verify", "--delete", "--ignore-case"]);
/** `git tag` short options whose value is the rest of the cluster. */
const TAG_ARG_SHORT = new Set(["u", "m", "F", "c", "C"]);

/**
 * `git tag` argument analysis: true when it creates a tag.
 * @param args - Arguments after `tag`.
 */
function tagCreates(args: readonly string[]): boolean {
  let list = false;
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") { positional ||= i + 1 < args.length; break; }
    if (a.startsWith("--")) {
      const name = a.split("=")[0] ?? a;
      if (TAG_CREATE_LONG.has(name)) return true;
      if (TAG_LIST_LONG.has(name)) list = true;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (const c of a.slice(1)) {
        if ("asufmeF".includes(c)) return true;
        if ("lnvdi".includes(c)) list = true;
        if (TAG_ARG_SHORT.has(c)) break;
        if (/\d/.test(c)) break;
      }
      continue;
    }
    positional = true;
  }
  return positional && !list;
}

/**
 * The git subcommand of one shell segment, behind env prefixes, wrappers and
 * git global options (`-C x`, `-c k=v`, `--no-pager`); `null` when the
 * segment's verb is not git. Does not recurse into `sh -c` or substitutions.
 * @param segment - One already-split shell segment.
 */
export function gitSubcommand(segment: string): GitParts | null {
  const tokens = peel(commandTokens(segment));
  return basename(tokens[0] ?? "") === "git" ? gitParts(tokens) : null;
}

/**
 * The release step one walked command performs, or null.
 * @param item - Verb and canonical argv of one command found by {@link expand}.
 */
function stepOf(item: { verb: string; argv: readonly string[] }): ReleaseAction | null {
  if (item.verb === "gh" && item.argv[0] === "pr" && item.argv[1] === "merge") return "merge";
  if (item.verb === "git" && item.argv[0] === "tag" && tagCreates(item.argv.slice(1))) return "tag";
  return null;
}

/**
 * The release step `command` performs, or `null` (commit, push, tag listing…): the wrapper-aware walk, else the
 * merge-base classifier. Never weaker than {@link baseReleaseAction}.
 * @param command - Raw Bash command.
 */
export function releaseAction(command: string): ReleaseAction | null {
  const hit: { step: ReleaseAction | null } = { step: null };
  expand(command, (item) => { hit.step ??= stepOf(item); return hit.step !== null; });
  return hit.step ?? baseReleaseAction(command);
}

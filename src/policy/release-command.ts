/**
 * @module release-command
 * Classify a Bash command as a release step: `gh pr merge` ("merge") or a
 * tag-creating `git tag` ("tag"). Reuses the shell segment splitter and
 * tokenizer of the motion guards (no ad-hoc regex on the raw string).
 *
 * Decisions: `git tag` with no positional / `-l` / `--list` / `-n` /
 * `--contains` / `--points-at` / `-v` / `-d` (read or delete) is NOT a release
 * step; any create flag (`-a -s -u -m -F -f`) or a positional tag name is.
 * `gh api …/merge` is out of scope (only `gh pr merge` is gated).
 */
import { basename } from "node:path";
import { stripDataHeredocs } from "./release-heredoc";
import { commandTokens, literalShellPayload, shellSegments } from "./motion/shell-verbs";

/** The release step a command performs. */
export type ReleaseAction = "merge" | "tag";

const MAX_DEPTH = 8;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);
const WRAPPERS = new Set(["command", "env", "exec", "sudo", "nohup", "time", "nice", "builtin", "xargs", "stdbuf", "ionice", "timeout"]);
/** git global options that consume the following token. */
const GIT_ARG_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const GH_ARG_OPTS = new Set(["-R", "--repo", "--hostname"]);
const TAG_CREATE_LONG = new Set(["--annotate", "--sign", "--local-user", "--message", "--file", "--force", "--edit"]);
const TAG_LIST_LONG = new Set(["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--verify", "--delete", "--ignore-case"]);
const TAG_ARG_SHORT = new Set(["u", "m", "F", "c", "C"]);

/** Drop quote and backslash characters inside a token (`g''h`, `\git`, `"tag"`). */
const clean = (t: string): string => t.replace(/['"\\]/g, "");

/** Bodies of `$(…)` and backtick substitutions in `text`, skipping single-quoted spans. */
function substitutions(text: string): string[] {
  const out: string[] = [];
  let single = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "'") { single = !single; continue; }
    if (single) continue;
    if (ch === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      out.push(text.slice(i + 1, end < 0 ? text.length : end));
      if (end < 0) break;
      i = end;
    }
  }
  return out;
}

/** `git tag` argument analysis: true when it creates a tag. */
function tagCreates(args: string[]): boolean {
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
        if ("asufmeFcC".includes(c) && c !== "c" && c !== "C") return true;
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

/** Strip wrappers/options in front of the real verb; returns the tokens from the verb on. */
function peel(tokens: string[]): string[] {
  let t = tokens.map(clean);
  for (let guard = 0; guard < 16 && t.length > 0; guard++) {
    const verb = basename(t[0] ?? "");
    if (!WRAPPERS.has(verb)) break;
    t = t.slice(1);
    while (t.length > 0 && (/^-/.test(t[0] ?? "") || /^[A-Za-z_]\w*=/.test(t[0] ?? "") || (verb === "timeout" && /^\d/.test(t[0] ?? "")))) t = t.slice(1);
  }
  return t;
}

/** Parsed `git` invocation: the subcommand, its arguments and the `-C` directories (in order). */
export interface GitParts { sub: string; args: string[]; dirs: string[] }

/** Split peeled git tokens (`git`, global options, subcommand, args). */
function gitParts(tokens: string[]): GitParts {
  const rest = tokens.slice(1);
  const dirs: string[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (GIT_ARG_OPTS.has(a)) {
      if (a === "-C" && rest[i + 1] !== undefined) dirs.push(rest[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    break;
  }
  return { sub: rest[i] ?? "", args: rest.slice(i + 1), dirs };
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

/** Classify one already-split segment (recursing into shell payloads / substitutions). */
function classifySegment(segment: string, depth: number): ReleaseAction | null {
  const raw = commandTokens(segment);
  const tokens = peel(raw);
  const verb = basename(tokens[0] ?? "");
  if (verb === "gh") {
    const rest = tokens.slice(1);
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] ?? "";
      if (GH_ARG_OPTS.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      words.push(a);
      if (words.length === 2) break;
    }
    if (words[0] === "pr" && words[1] === "merge") return "merge";
  } else if (verb === "git") {
    const git = gitParts(tokens);
    if (git.sub === "commit") return null;
    if (git.sub === "tag" && tagCreates(git.args)) return "tag";
    if (git.sub === "tag") return null;
  }
  if (depth >= MAX_DEPTH) return null;
  if (SHELLS.has(verb)) {
    const inner = literalShellPayload(segment);
    for (const text of inner ? [inner] : tokens.slice(1).filter((t) => /\s/.test(t))) {
      const found = classify(text, depth + 1);
      if (found) return found;
    }
  }
  for (const body of substitutions(segment)) {
    const found = classify(body, depth + 1);
    if (found) return found;
  }
  return null;
}

function classify(command: string, depth: number): ReleaseAction | null {
  for (const segment of shellSegments(command)) {
    const found = classifySegment(segment, depth);
    if (found) return found;
  }
  return null;
}

/**
 * The release step `command` performs, or `null` (commit, push, tag listing…).
 * @param command - Raw Bash command.
 */
export function releaseAction(command: string): ReleaseAction | null {
  // Strip data heredocs once, on the full command (the eval/shell context is only visible here).
  return classify(stripDataHeredocs(command), 0);
}

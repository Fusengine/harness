/**
 * @module release-command-base
 * The release classifier exactly as it was on the merge base (ddcf2d7), kept
 * VERBATIM (only the export name differs). `releaseAction` returns its result
 * whenever the wrapper-aware walk finds nothing, so the release gate can never be
 * weaker than it was before the wrapper-aware policy. Do not edit: its behaviour is the law.
 */
import { basename } from "node:path";
import { stripDataHeredocs } from "./release-heredoc";
import { commandTokens, literalShellPayload, shellSegments } from "./motion/shell-verbs";

/** The release step a command performs (merge-base shape). */
type BaseReleaseAction = "merge" | "tag";

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

/** Classify one already-split segment (recursing into shell payloads / substitutions). */
function classifySegment(segment: string, depth: number): BaseReleaseAction | null {
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
    const rest = tokens.slice(1);
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i] ?? "";
      if (GIT_ARG_OPTS.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      break;
    }
    if (rest[i] === "commit") return null;
    if (rest[i] === "tag" && tagCreates(rest.slice(i + 1))) return "tag";
    if (rest[i] === "tag") return null;
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

/** Classify every segment of `command`, first release step wins. */
function classify(command: string, depth: number): BaseReleaseAction | null {
  for (const segment of shellSegments(command)) {
    const found = classifySegment(segment, depth);
    if (found) return found;
  }
  return null;
}

/**
 * The release step `command` performs, or `null` — the merge-base classifier, verbatim.
 * @param command - Raw Bash command.
 */
export function baseReleaseAction(command: string): BaseReleaseAction | null {
  // Strip data heredocs once, on the full command (the eval/shell context is only visible here).
  return classify(stripDataHeredocs(command), 0);
}

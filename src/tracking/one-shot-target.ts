/**
 * @module one-shot-target
 * Which file a denied Bash write would have written — so the Write/Edit that
 * replaces it can credit the gate (the op keys differ: Bash key = whole command).
 * Reuses the guard's own redirect scanner and code-file pattern; no new grammar.
 * @packageDocumentation
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { shellFileWriteRedirects } from "../policy/guards/bash-write-redirects";
import { CODE_FILE_LITERAL } from "../policy/guards/bash-write-patterns";
import { bashWriteGuard } from "../policy/guards/bash-write";
import { segments } from "../policy/shell-read-refs";
import type { Prompt } from "../prompt/types";
import type { OutcomeMeta } from "./one-shot-types";

/** Gate titles of a Bash write denial (`bash-write.ts`, `bash-write-literal.ts`). */
const BASH_WRITE_TITLE = /^Bash (?:file )?write\b/;

/** A path-looking word ending in a code extension (extension list = the guard's {@link CODE_FILE_LITERAL}). */
const CODE_WORD = new RegExp(`[^\\s"'\`<>|;&()=,]+${CODE_FILE_LITERAL.source}`, "gi");

/** True when `title` is a Bash-write gate's block title. */
export function isBashWriteTitle(title: string): boolean {
  return BASH_WRITE_TITLE.test(title);
}

/**
 * Target identity of one gate outcome: a Bash-write block → the code files the
 * command targets; an allowed file edit (has `filePath` + `content`) → that file.
 * @param prompt - The gate's outcome (block, or null = allow).
 * @param input - Identifying tool input.
 * @param cwd - Base for relative paths.
 * @param sid - Session id, recorded on the event.
 */
export function outcomeMeta(
  prompt: Prompt | null,
  input: { filePath?: string; content?: string; command?: string },
  cwd?: string,
  sid?: string,
): OutcomeMeta {
  const meta: OutcomeMeta = sid ? { sid } : {};
  if (prompt && input.command && isBashWriteTitle(prompt.title)) meta.targets = bashWriteTargets(input.command, cwd);
  if (!prompt && input.filePath && input.content != null) meta.target = normalizeTarget(input.filePath, cwd);
  return meta;
}

/**
 * Absolute, normalized form of `path` (relative paths resolve against `cwd`, else
 * the process cwd). The parent directory is symlink-resolved when it exists, so
 * `/tmp/x.ts` and `/private/tmp/x.ts` compare equal on both the deny and fix side.
 */
export function normalizeTarget(path: string, cwd?: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path);
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** `cd <dir> &&` / `cd <dir> ;` prefix → the directory it enters; `null` when `cd` appears anywhere else. */
function commandBase(command: string, cwd?: string): { base: string | undefined; ok: boolean } {
  const lead = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(command);
  const rest = lead ? command.slice(lead[0].length) : command;
  if (/\b(?:cd|pushd|popd)\b/.test(rest)) return { base: cwd, ok: false };
  return { base: lead ? normalizeTarget(lead[1]!.replace(/^["']|["']$/g, ""), cwd) : cwd, ok: true };
}

/**
 * Code-file words of the shell segment(s) (split on `&&`, `||`, `;`, `|`, newline —
 * the shared {@link segments}) the guard itself blocks; `sed -i s/x/y/ a.ts && cat c.ts`
 * yields only `a.ts`. When no single segment blocks (a construct spanning segments),
 * every code-file word of the command is kept — never fewer targets than before.
 */
function writingSegmentWords(command: string): string[] {
  const writing = segments(command).filter((seg) => bashWriteGuard({ tool: "Bash", command: seg })?.kind === "block");
  return (writing.length > 0 ? writing : [command]).flatMap((seg) => seg.match(CODE_WORD) ?? []);
}

/**
 * Absolute code-file paths a denied Bash write targets: the code-file redirect
 * targets when there are any, else the code-file words of the writing segment. Words
 * with `$`/glob characters are skipped (not a single known file).
 */
export function bashWriteTargets(command: string, cwdIn?: string): string[] {
  const { base: cwd, ok } = commandBase(command, cwdIn);
  if (!ok) return []; // a mid-command cd/pushd/popd: the working dir is unknown → no credit rather than a wrong one
  const redirected = shellFileWriteRedirects(command).map((r) => r.target).filter((t) => CODE_FILE_LITERAL.test(t));
  const words = redirected.length > 0 ? redirected : writingSegmentWords(command);
  const clean = words.map((w) => w.replace(/^["']|["']$/g, "")).filter((w) => !/[$*?[{]/.test(w));
  return [...new Set(clean.map((w) => normalizeTarget(w, cwd)))];
}

/**
 * @module prd-post-write
 * Derives the text a write WOULD leave at one target file, from the hook
 * payload (Claude Code Write/Edit, Codex apply_patch, Cursor edits) and the
 * file's current text. Used by the PRD router recovery/prevention guard to
 * judge the result of a write BEFORE it lands. Strictly conservative: any
 * case that is not exactly determinable (text not found, ambiguous match,
 * more than one `@@` chunk, blank chunk line, `\r` in the file, rename,
 * `@@ <context>` header, `*** End of File` marker, unsupported tool) yields
 * `{state:"unknown"}` — the caller must treat it as "cannot evaluate", never
 * as valid or invalid. Every operation on the target, whatever the path
 * spelling (`isTarget`), is folded in order; a delete is reported as such.
 */
import type { PatchHunk } from "../../adapters/codex/apply-patch";
import type { PostWrite, PostWriteInput } from "./interfaces/router-guard";

/** The comparison modes Codex's seek_sequence tries in turn: exact, rstrip, trim, Unicode-normalized. */
const MODES: ReadonlyArray<(line: string) => string> = [
  (l) => l,
  (l) => l.trimEnd(),
  (l) => l.trim(),
  (l) => l.normalize("NFKC").replace(/[‐-―−]/g, "-").replace(/[‘-‛]/g, "'").replace(/[“-‟]/g, '"').replace(/[\s ]+/g, " ").trim(),
];

/**
 * Index of the ONLY location of `want` within `lines` under EVERY Codex
 * comparison mode (a whitespace/Unicode twin anywhere in the file, in any
 * mode, makes it ambiguous); -1 when absent or ambiguous.
 * Mirrors codex-rs/apply-patch/src/seek_sequence.rs (exact, rstrip, trim, normalise).
 */
function uniqueLocation(lines: readonly string[], want: readonly string[]): number {
  let at = -1;
  for (const norm of MODES) {
    const w = want.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + w.length <= lines.length; i++) {
      if (w.every((line, k) => norm(lines[i + k] as string) === line)) hits.push(i);
    }
    if (hits.length !== 1 || (at !== -1 && at !== hits[0])) return -1;
    at = hits[0] as number;
  }
  return at;
}

/**
 * Applies ONE Codex `@@` chunk to an LF-only `text`, exactly as
 * codex-rs/apply-patch does (file_update.rs `compute_replacements`, text_file.rs
 * `SourceFile`): the file is split into lines WITHOUT a trailing empty element
 * (an unterminated last line is kept), the chunk's old lines are located, the
 * replaced span is swapped for the new lines, and EVERY resulting line is
 * written back with a `\n` (apply-patch always leaves a final newline).
 * Anything not provably identical returns `null`: several chunks, a pure-add
 * chunk, any blank old/new line (Codex's trailing-empty-line retry), a `\r`
 * in the file (mixed line-ending handling), or an old block that is not found
 * exactly once in every comparison mode.
 */
function applyHunks(text: string, hunks: readonly PatchHunk[]): string | null {
  const [h] = hunks;
  if (hunks.length !== 1 || !h || h.oldString === "" || text.includes("\r")) return null;
  const lines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const oldLines = h.oldString.split("\n");
  const newLines = h.deletion ? [] : h.newString.split("\n");
  if (oldLines.includes("") || newLines.includes("")) return null;
  const at = uniqueLocation(lines, oldLines);
  if (at === -1) return null;
  const out = [...lines.slice(0, at), ...newLines, ...lines.slice(at + oldLines.length)];
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** Replaces `oldString` by `newString` like Edit: exactly one match, or every match under `replaceAll`; `null` otherwise. */
function applyEdit(text: string, oldString: string, newString: string, replaceAll: boolean): string | null {
  if (oldString === "") return null;
  const parts = text.split(oldString);
  if (parts.length === 1 || (!replaceAll && parts.length !== 2)) return null;
  return parts.join(newString);
}

const UNKNOWN: PostWrite = { state: "unknown" };
/** A rename, an `*** End of File` marker or an `@@ <context>` header: Codex anchors/relocates by them in ways not reproduced here. */
const UNRESOLVABLE_PATCH = /^\s*\*\*\* Move to: |^\s*\*\*\* End of File|^@@[ \t]*\S/m;

/** Folds every operation on the target (any spelling), in patch order, over `current`. */
function derivePatchLike({ event, patch, isTarget, current }: PostWriteInput): PostWrite {
  if (UNRESOLVABLE_PATCH.test(patch)) return UNKNOWN;
  const mine = (event.files ?? []).filter((f) => isTarget(f.filePath));
  if (mine.length === 0) return UNKNOWN;
  // `end` is the net state so far; an operation that cannot be applied makes it
  // unknown, but a LATER Add/Delete still overrides it (it replaces the whole file).
  let end: PostWrite = current === null ? UNKNOWN : { state: "text", text: current };
  for (const f of mine) {
    if (f.op === "delete") end = { state: "deleted" };
    else if (f.op === "add") end = { state: "text", text: f.content };
    else if (end.state !== "text") end = UNKNOWN;
    else {
      const next = f.hunks ? applyHunks(end.text, f.hunks) : f.oldString !== undefined ? applyEdit(end.text, f.oldString, f.content, false) : null;
      end = next === null ? UNKNOWN : { state: "text", text: next };
    }
  }
  return end;
}

/**
 * What this write leaves at the target.
 * @param input - Event, raw patch text, target matcher and the target's current text.
 * @returns The post-write text, a deletion, or `{state:"unknown"}` when not determinable with certainty.
 */
export function derivePostWrite(input: PostWriteInput): PostWrite {
  const { event, current } = input;
  if (event.files?.length) return derivePatchLike(input);
  if (event.tool === "Write") return typeof event.content === "string" ? { state: "text", text: event.content } : UNKNOWN;
  if (event.tool === "Edit" && current !== null && event.oldString !== undefined && event.content !== undefined) {
    const text = applyEdit(current, event.oldString, event.content, event.input.replace_all === true);
    return text === null ? UNKNOWN : { state: "text", text };
  }
  return UNKNOWN;
}

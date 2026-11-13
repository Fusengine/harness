import { isAbsolute, relative } from "node:path";
import { protectedPathGate } from "../policy/trivial-edits";
import { evaluate } from "../policy/evaluate";
import { dryGate } from "./dry";
import { existingLineCounts } from "./gate-helpers";
import { countLines } from "../policy/file-size";
import type { PatchHunk } from "../adapters/codex/apply-patch";
import type { NormalizedFile } from "./normalize";
import type { Prompt } from "../prompt/types";

/**
 * The path a Codex agent must recopy into `*** Update File:` to act on the
 * SOLID deny — Codex's apply_patch only accepts project-relative paths, so an
 * absolute `filePath` is rebased onto `cwd`; a relative one is kept verbatim.
 * @param filePath - The patched file as normalized from the envelope.
 * @param cwd - Project root.
 */
function patchPathFor(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
}

/** Every `update` entry's hunks merged per path, so N `*** Update File:` blocks on the same file are judged once, cumulatively — Codex applies them in sequence on one file. */
function mergedHunksByPath(files: readonly NormalizedFile[]): Map<string, PatchHunk[]> {
  const byPath = new Map<string, PatchHunk[]>();
  for (const f of files) {
    if (f.op !== "update" || !f.hunks) continue;
    byPath.set(f.filePath, [...(byPath.get(f.filePath) ?? []), ...f.hunks]);
  }
  return byPath;
}

/** The content of an `add` entry per path — an `update` on a path added in the SAME envelope is applied to that new content, not to the (missing) on-disk file. */
function addedContentByPath(files: readonly NormalizedFile[]): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const f of files) if (f.op === "add") byPath.set(f.filePath, `${f.content}\n`);
  return byPath;
}

/**
 * OR the static per-file verdict for a Codex `apply_patch` envelope: run the
 * file-level gates (protected-path, SOLID file-size, DRY) that key off
 * `filePath`/`content` over EACH touched file and return the first blocking
 * {@link Prompt}. One violating hunk blocks the whole patch — the parity the
 * single-file `Write`/`Edit` path already has, extended to the multi-file
 * primitive.
 *
 * Only the read-only/pure gates run here (no session-state writes), so the
 * `~11×` hook fan-out stays idempotent — the stateful APEX freshness/skill
 * gates are tool-level and never policed `apply_patch` (its `filePath` was
 * always undefined), so they are intentionally out of scope.
 *
 * File-size tool mapping mirrors Claude: an `add` is judged like a `Write`
 * (full new content), an `update` like an `Edit` — judged against the file
 * AFTER the patch: every pre-sized `@@` chunk (`f.hunks`) is located in the
 * real on-disk content and the summed delta applied to the existing line
 * count (`policy/edit-outcome.ts::computePatchResultLines`), so a shrinking
 * patch is allowed even on an already-oversized file, while a chunk that
 * cannot be located or trusted fails closed to the on-disk count alone.
 * `f.content` stays the merged new side of the whole Update File block, the
 * shape the DRY gate (and every other `event.files` consumer) always saw.
 * @param files - Per-file changes from {@link NormalizedFile}.
 * @param cwd - Project root for the DRY codebase grep.
 * @returns The first blocking prompt, or null when every file passes.
 */
export function applyPatchGate(files: readonly NormalizedFile[], cwd: string): Prompt | null {
  const merged = mergedHunksByPath(files);
  const added = addedContentByPath(files);
  const judgedUpdates = new Set<string>();
  let note: Prompt | null = null;
  for (const f of files) {
    const tool = f.op === "add" ? "Write" : "Edit";
    const protectedDeny = protectedPathGate(tool, f.filePath);
    if (protectedDeny) return protectedDeny;
    if (f.op === "delete") continue;
    // SOLID file-size is judged ONCE per path (cumulative hunks via `merged`),
    // never re-run on a later `*** Update File:` block for the same path — but
    // DRY below must still run for every block, since it greps each block's OWN
    // `content` for newly declared symbols, independent of file-size merging.
    const alreadyJudgedSize = f.op === "update" && judgedUpdates.has(f.filePath);
    if (f.op === "update") judgedUpdates.add(f.filePath);
    if (!alreadyJudgedSize) {
      const disk = existingLineCounts(f.filePath);
      const addedContent = f.op === "update" ? added.get(f.filePath) : undefined;
      const existingContent = addedContent ?? disk.content;
      const existingLines = addedContent !== undefined ? countLines(addedContent) : disk.raw;
      const quick = evaluate({
        tool,
        filePath: f.filePath,
        content: f.content,
        existingLines,
        existingContent,
        hunks: f.op === "update" ? merged.get(f.filePath) : undefined,
        target: "codex",
        patchPath: patchPathFor(f.filePath, cwd),
      });
      if (quick.decision !== "allow" && quick.prompt) return quick.prompt;
    }
    const dry = dryGate(tool, f.filePath, f.content, cwd);
    // An advisory `inform` (duplicate hint / skipped check) must not end the loop: later files still need their static gates.
    if (dry?.kind === "inform") note ??= dry;
    else if (dry) return dry;
  }
  return note;
}

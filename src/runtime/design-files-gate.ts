/**
 * @module design-files-gate
 * Gates for multi-file write primitives (Codex `apply_patch`, fanned into
 * `event.files` by normalize.ts): apply_patch IS the Write tool under Codex,
 * so the design pipeline must see it. Per op, because `content` means
 * different things (apply-patch.ts:10-15):
 *  - add:    content IS the full new document — content-gated like a Write;
 *  - update: content is the hunk's new side, APPROXIMATE, never the document —
 *            only content-independent gates run (path, state-file, phase/quota).
 *            No BLOCKING or DEGRADING validation on this path — promote-only:
 *            the POST re-reads the real file, a clean content promotes to
 *            phase 3, a dirty one changes nothing. And it would not bite
 *            anyway: designSystemValid is consumed ONLY under
 *            FUSE_DESIGN_GEMINI=1 (off by default — an informational flag),
 *            and designSystemExists is never read after init;
 *  - delete: skipped (parity with the sibling applyPatchGate).
 * One violating file blocks the whole envelope. `htmlCssOnlyGate` NOW applies
 * here too (owner D2 revised): the two write paths must not diverge on what
 * the design agent may write — an `apply_patch` `.tsx`/`.astro`/etc. add or
 * update is just as much a framework-file write as the same content via
 * `Write`/`Edit`, and letting it through only on this path was an unintended
 * apply_patch-shaped bypass, not a deliberate relaxation. `uiDesignSkillGate`
 * and the Gemini create_frontend precondition NO LONGER bypass apply_patch
 * (fixed): the skill gate is wired in `design.ts` on `event.files` (same
 * any-agent scope as its Write/Edit call site, before the agentId
 * early-return); the Gemini precondition is ported into this function,
 * right below `htmlCssOnlyGate`, gated the same way (opt-in,
 * FUSE_DESIGN_GEMINI, state.geminiCalls === 0). REMAINING KNOWN GAPS
 * (documented, still out of scope):
 * `Design-System.md` (case) escapes every endsWith check, here and on
 * Write — a real bypass on case-insensitive macOS, not widened now; and
 * `*** Move to:` (apply-patch.ts:76-79) unconditionally OVERWRITES `cur.path`
 * on ANY preceding op (`Add File`/`Update File`), so a `*** Update File: a.css`
 * + `Move to: a.tsx` sequence surfaces here as `filePath` ending in `.tsx`
 * (correctly blocked — NOT a bypass, verified against the parser). The
 * un-verified direction is the reverse: `Add File: a.tsx` + `Move to: a.css`
 * would surface only the PERMITTED destination extension while `f.content`
 * is real framework code — the source path is never preserved anywhere, and
 * this gate (like Write's htmlCssOnlyGate) checks only the extension, never
 * the content's actual syntax. Whether Codex's real grammar allows Move-to
 * after an Add (vs. Update-only) is unconfirmed; flagged, not fixed here.
 * Also: the POST side still does NOT run `runDesignChecks` (tsx/jsx/css
 * warnings) on an `apply_patch` file — `handle-post.ts` keeps `designGate` on
 * the RAW, un-fanned envelope there (recordPost's apply_patch branch is
 * promote-only and resolves `design-system.md` via `join(cwd, …)`; routing a
 * fanned Write/Edit-shaped event through it instead would read `filePath`
 * UNRESOLVED and risk degrading the state — a real regression, not a
 * hypothetical one). Restoring the tsx/jsx/css warning would require
 * resolving relative apply_patch paths AND preserving the promote-only
 * doctrine inside `recordPost` at the same time — out of scope here, owner
 * decision.
 * @packageDocumentation
 */
import type { Prompt } from "../prompt/types";
import type { NormalizedFile } from "./normalize";
import type { DesignState } from "../policy/design/state";
import { pluginsWriteGuard } from "../policy/design/corpus";
import { htmlCssOnlyGate, stateFileGate, geminiEnabled } from "../policy/design/gates";
import { designSystemWriteGate, htmlCssPipelineGate } from "../policy/design/gates-pipeline";
import { designSystemContentGate } from "./design-content-gate";

/**
 * Literal substitution, first occurrence or all — NEVER String.replace's
 * replacement-string semantics: an agent-controlled new_string of `$&`, `` $` ``,
 * `$'` or `$$` must be written (and validated) literally, not interpreted as
 * the matched text (that made the gate validate a document the tool would
 * never write — the `$&` bypass). Used on both sides: PRE reconstruction and
 * POST reverse-reconstruction.
 */
export function substituteLiteral(s: string, from: string, to: string, all: boolean): string {
  return all ? s.split(from).join(to) : s.replace(from, () => to);
}

/**
 * Gate every file of a multi-file write primitive; the first violation blocks
 * the envelope. `designSystemExistsFor` is caller-injected (`findDesignSystem*`
 * lives in `design-helpers.ts`, which itself imports `substituteLiteral` from
 * THIS module — importing it back here would cycle) and is evaluated PER FILE:
 * each patched file gets the same design-system.md verdict it would get
 * written alone by Write/Edit — a hit for one file never leaks to the others.
 */
export function designFilesGate(
  files: readonly NormalizedFile[],
  state: DesignState,
  pluginsRoot: string,
  corpusRoot: string,
  corpusRequired: boolean,
  cwd: string,
  designSystemExistsFor: (filePath: string) => boolean,
): Prompt | null {
  for (const f of files) {
    const hit = pluginsWriteGuard(f.filePath, pluginsRoot, cwd) ?? stateFileGate(f.filePath);
    if (hit) return hit;
    if (f.op === "delete") continue;
    const htmlCssHit = htmlCssOnlyGate(f.filePath);
    if (htmlCssHit) return htmlCssHit;
    // Parity with design.ts's htmlCssPipelineGate call: SAME verdict for the
    // SAME file+state on both write paths (Write/Edit vs apply_patch).
    const pipelineHit = htmlCssPipelineGate(f.filePath, state, designSystemExistsFor(f.filePath));
    if (pipelineHit) return pipelineHit;
    // apply_patch parity for the Gemini precondition (design.ts:72-74, D2 gap):
    // same condition, same Prompt shape as the Write/Edit branch — opt-in via
    // FUSE_DESIGN_GEMINI (OFF by default), so a no-op when Gemini is disabled.
    if (geminiEnabled() && state.geminiCalls === 0 && /\.(html|css)$/.test(f.filePath)) {
      return { kind: "block", title: "Design pipeline", reason: "BLOCKED: generate the frontend via create_frontend before hand-writing HTML/CSS.", actions: ["Call mcp__gemini-design__create_frontend first"] };
    }
    if (!f.filePath.endsWith("design-system.md")) continue;
    const gate = designSystemWriteGate(f.filePath, state, corpusRequired, corpusRoot)
      ?? (f.op === "add"
        ? designSystemContentGate({ filePath: f.filePath, tool: "Write", content: f.content, oldString: undefined, replaceAll: false, state, corpusRoot, corpusRequired })
        : null);
    if (gate) return gate;
  }
  return null;
}

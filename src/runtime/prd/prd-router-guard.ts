/**
 * @module prd-router-guard
 * Router-specific decisions for {@link prdPreGate}:
 * - {@link brokenRouterVerdict}: the router is absent-of-validity (unparsable
 *   or off-schema). Without this, the gate denied every PRD-scoped write —
 *   including the repair itself — before identity or content were looked at.
 *   The ONE exception: the authorized coordinator (existing ownership policy)
 *   writing the router file ALONE, with a post-write content that provably
 *   parses and passes the schema. Everything else is denied with the exact
 *   diagnostic (never a generic "malformed JSON").
 * - {@link routerWriteViolation}: prevention — a write that would turn a
 *   VALID router invalid is denied; content that cannot be derived is NOT
 *   judged (today's behaviour is kept for what cannot be evaluated).
 */
import {
  classifyPrdPath, classifyRouterText, describeRouterState, evaluateWriteOwnership, isPrdScopedPath, prdRouterPath,
} from "../../policy/prd";
import { isAbsolute, resolve } from "node:path";
import type { NormalizedEvent } from "../normalize";
import type { BrokenRouterInput, BrokenRouterVerdict } from "./interfaces/router-guard";
import { canonicalFilePath } from "./prd-canon";
import { derivePostWrite } from "./prd-post-write";

const isRouter = (f: string, root: string, homeSeg: string): boolean => classifyPrdPath(f, root, homeSeg, null)?.kind === "router";

/** Matcher for "this path, in ANY spelling (relative, `./`, absolute, `//`, symlinked parent), is the router". */
function routerMatcher(root: string, homeSeg: string): (path: string) => boolean {
  return (p) => isRouter(canonicalFilePath(resolve(isAbsolute(p) ? p : resolve(root, p))), root, homeSeg);
}

/** The raw apply_patch text, read exactly as `normalizeEvent` does (`tool_input.command`, else top-level `command`); "" otherwise. */
export function patchTextOf(event: NormalizedEvent, payload: Record<string, unknown>): string {
  const cmd = event.input.command ?? payload.command;
  return typeof cmd === "string" ? cmd : "";
}

/**
 * Decide a write while the router is syntactically or schema-invalid.
 * @returns `null` when no candidate is PRD-scoped (fall through untouched),
 * else the {@link BrokenRouterVerdict}.
 */
export function brokenRouterVerdict(input: BrokenRouterInput): BrokenRouterVerdict | null {
  const { snapshot, event, files, root, homeSeg, identity } = input;
  if (!files.some((f) => isPrdScopedPath(f, root, homeSeg))) return null;
  const routerPath = prdRouterPath(root, homeSeg);
  const diagnostic = describeRouterState(snapshot.state, routerPath);

  const routerFiles = files.filter((f) => isRouter(f, root, homeSeg));
  if (routerFiles.length > 0) {
    const verdict = evaluateWriteOwnership({ kind: { kind: "router" }, identity, taskFile: null, bindings: {} });
    if (verdict.allow === false) return { allow: false, reason: `${routerFiles[0]}: ${verdict.reason}` };
  }
  if (routerFiles.length !== files.length) {
    return { allow: false, reason: `${diagnostic}. Only a write to the router file alone can repair it; no other PRD file can be written until then.` };
  }
  // Recovery = exactly ONE file operation in the whole patch, and it is the router.
  if ((event.files?.length ?? 1) !== 1) {
    return { allow: false, reason: `${diagnostic}. A repair must be a single operation on the router file; this patch has ${event.files?.length}.` };
  }
  const next = derivePostWrite({ event, patch: input.patch, isTarget: routerMatcher(root, homeSeg), current: snapshot.text });
  if (next.state !== "text") {
    return { allow: false, reason: `${diagnostic}. The harness cannot determine with certainty what this write would leave in the router — repair it with one Write, a single Add, or an Edit/apply_patch Update (bare @@, old text matching exactly once).` };
  }
  const after = classifyRouterText(next.text);
  if (after.state !== "ok") return { allow: false, reason: `this write leaves the router invalid — ${describeRouterState(after, routerPath)}` };
  return { allow: true };
}

/**
 * Prevention for a write to a currently VALID router.
 * Judges the WHOLE event's net effect on the router (every operation, any path spelling).
 * @param event - The normalized write event (every file operation it carries is considered).
 * @param patch - Raw apply_patch text ("" for other tools).
 * @param currentText - The router's current text.
 * @param root - Project root the router path is resolved against.
 * @param homeSeg - Harness home segment (`<root>/<homeSeg>/apex/prd.json`).
 * @returns A deny reason when the write would leave the router invalid or delete it, else `null` (valid result, or not derivable).
 */
export function routerWriteViolation(event: NormalizedEvent, patch: string, currentText: string | null, root: string, homeSeg: string): string | null {
  const next = derivePostWrite({ event, patch, isTarget: routerMatcher(root, homeSeg), current: currentText });
  if (next.state === "unknown") return null;
  const routerPath = prdRouterPath(root, homeSeg);
  if (next.state === "deleted") return `this write would delete the router (PRD enforcement would switch off) — ${routerPath}`;
  const after = classifyRouterText(next.text);
  return after.state === "ok" ? null : `this write would turn a valid router invalid — ${describeRouterState(after, routerPath)}`;
}

/**
 * @module prd-pre-gate
 * PreToolUse orchestrator for the PRD module (design doc §2.0/§2.1). Inert
 * unless {@link isPrdEnabled}: one env read + one `statSync`, zero further
 * disk access. When active, denies a Bash write under `apex/prd/` for
 * EVERYONE (no identity check needed — see below) — covering both shell
 * output redirects (`>`/`>>`, `shellOutputRedirects`) AND the non-redirect
 * write verbs `cp`, `mv`, `tee`, `sed -i`/`perl -i`, `install`, `dd of=`
 * (`extraBashWriteTargets`, `prd-bash-targets.ts`) — then resolves ownership
 * for Write/Edit/apply_patch/afterFileEdit targets and either short-circuits
 * past `gate()`/`protectedPathGuard` with an allow, or returns the standard
 * deny — never both, never a silent pass-through of a denied write.
 */
import { dirname } from "node:path";
import type { Prompt } from "../../prompt/types";
import { respond } from "../respond";
import { withDenyNotice } from "../deny-notice";
import { allowOutcome } from "../pre-allow";
import { projectLayout } from "../../config/layout";
import { harnessHomeSegment } from "../../policy/apex-target";
import { shellOutputRedirects } from "../../policy/guards/bash-write-redirects";
import { extraBashWriteTargets } from "./prd-bash-targets";
import {
  candidateAgentNames, classifyPrdPath, evaluateWriteOwnership, isPrdEnabled, isPrdScopedPath,
  prdProjectRoot, readAllTaskFiles, readRouterSnapshotSync,
  type PrdOwnershipVerdict, type PrdPathKind, type PrdTaskFile,
} from "../../policy/prd";
import { brokenRouterVerdict, patchTextOf, routerWriteViolation } from "./prd-router-guard";
import { loadTrack, withTrack } from "../../tracking/store";
import { recordPrdOwner } from "../../tracking/session-state";
import { resolvePrdIdentity } from "./prd-identity";
import { prdCandidateFiles } from "./prd-candidate-files";
import { canonicalFilePath, canonicalRoot } from "./prd-canon";
import type { NormalizedEvent } from "../normalize";
import type { HandleOutcome } from "../handle";

const ACTIONS = ["Write only the files/report this agent owns per its PRD slice", "Run `harness prd status` to see the current assignment"];

function denyOutcome(id: string, event: NormalizedEvent, trackFilePath: string, now: number, reason: string): HandleOutcome {
  const prompt: Prompt = { kind: "block", ruleId: "prd-ownership", title: "PRD ownership", reason, actions: ACTIONS };
  return { stdout: withDenyNotice(id, respond(id, prompt, event.eventName ?? "PreToolUse"), prompt, event.sessionId, dirname(trackFilePath), now), exit: 0 };
}

/**
 * Narrows `taskFile` to the names `evaluateWriteOwnership` needs to correctly
 * resolve a SPECIFIC requested agent-report name, WITHOUT changing lot A's
 * pure `resolveOwnerBinding`/`evaluateWriteOwnership` (unmodified) — a lot B
 * integration adapter around a real call-site gap, not a policy change.
 *
 * Two rules, matching the design's "first-come, exact-name-first" contract:
 * - `target === agentType` (claiming YOUR OWN exact name): always legitimate
 *   on a cold start — narrow to just `target`, so a same-type SIBLING's mere
 *   existence never manufactures a false "ambiguous" (`resolveOwnerBinding`
 *   otherwise sees 2 equally-free candidates and gives up for BOTH).
 * - `target !== agentType` (claiming a "-n" SIBLING slot): only legitimate
 *   once the EXACT-match name is already claimed by someone else — keep
 *   BOTH names, so `resolveOwnerBinding` sees 2 free candidates (denied,
 *   ambiguous) until the exact slot is taken, then exactly 1 (allowed).
 * In every case, this agentId's own EXISTING binding (if any) and every
 * name already claimed by anyone are also kept, so a mismatch against an
 * established binding is still caught (never silently dropped from view).
 */
function narrowForTarget(taskFile: PrdTaskFile, agentType: string, target: string, agentId: string, bindings: Record<string, string>): PrdTaskFile {
  const allCandidates = candidateAgentNames(agentType, taskFile);
  const keep = new Set<string>([target]);
  if (target !== agentType) keep.add(agentType);
  const myBinding = bindings[agentId];
  if (myBinding !== undefined) keep.add(myBinding);
  for (const name of Object.values(bindings)) keep.add(name);
  const out: PrdTaskFile = {};
  for (const name of allCandidates) {
    const entry = taskFile[name];
    if (keep.has(name) && entry) out[name] = entry;
  }
  return out;
}

/** The task-PRD (if any) that declares `agent` as a literal key, across every task in the router. */
function governingTaskFile(agent: string, taskFiles: Record<string, PrdTaskFile | null>): PrdTaskFile | null {
  for (const tf of Object.values(taskFiles)) {
    if (tf && Object.hasOwn(tf, agent)) return tf;
  }
  return null;
}

/**
 * Run the PreToolUse PRD gate.
 * @returns The native outcome (allow bypassing `gate()`, or deny), or `null`
 * to fall through to the ordinary pipeline (module off, or nothing in scope).
 */
export async function prdPreGate(
  id: string,
  payload: Record<string, unknown>,
  event: NormalizedEvent,
  cwd: string,
  trackFilePath: string,
  now: number,
): Promise<HandleOutcome | null> {
  if (!isPrdEnabled(cwd, id)) return null;
  // Canonicalized once: `isPrdScopedPath`/`classifyPrdPath` are pure
  // string/path compares (lot A, by design, no fs) — on macOS, `cwd` (from a
  // spawned process) resolves `/var` to `/private/var` while a caller's own
  // absolute path may still carry the unresolved alias, so root and target
  // must share ONE representation before any comparison (prd-canon.ts).
  const root = canonicalRoot(prdProjectRoot(cwd));
  const homeSeg = harnessHomeSegment(id);

  if (event.tool === "Bash" && event.command) {
    const redirectHit = shellOutputRedirects(event.command).some((r) => isPrdScopedPath(canonicalFilePath(r.target), root, homeSeg));
    // Beyond `>`/`>>` redirects: cp/mv/tee/sed -i/perl -i/install/dd of= also
    // write a file without any redirect operator (prd-bash-targets.ts, local
    // to this module — never merged into the shared bash-write-redirects.ts/
    // protectedPathGuard, see that file's own header for why).
    const verbHit = extraBashWriteTargets(event.command).some((t) => isPrdScopedPath(canonicalFilePath(t), root, homeSeg));
    if (redirectHit || verbHit) return denyOutcome(id, event, trackFilePath, now, "PRD files must be written via Write/Edit/apply_patch, never Bash.");
  }

  const files = prdCandidateFiles(event).map(canonicalFilePath);
  if (files.length === 0) return null;

  const mcpDir = projectLayout(cwd).cacheDir;
  const identity = resolvePrdIdentity(id, event);
  const snapshot = readRouterSnapshotSync(root, homeSeg);
  const routerState = snapshot.state;
  if (routerState.state !== "ok") {
    // Broken router (absent / syntax / schema): never the generic deny — the
    // coordinator's router-only repair is allowed, everything else is denied
    // with the precise diagnostic (prd-router-guard.ts).
    const verdict = brokenRouterVerdict({ snapshot, event, patch: patchTextOf(event, payload), files, root, homeSeg, identity });
    if (verdict === null) return null;
    if (verdict.allow === false) return denyOutcome(id, event, trackFilePath, now, verdict.reason);
    return allowOutcome(id, event, payload, mcpDir, cwd, { trackFile: trackFilePath, now });
  }
  const router = routerState.router;

  const inScope = files
    .map((f) => ({ file: f, kind: classifyPrdPath(f, root, homeSeg, router) }))
    .filter((c): c is { file: string; kind: PrdPathKind } => c.kind !== null && c.kind.kind !== "other");
  if (inScope.length === 0) return null;

  const track = await loadTrack(trackFilePath);
  // Mutated in-loop (never the loaded track): a 2nd agent-report file in the
  // SAME envelope must see the 1st file's pending bind, or a single agentId
  // could claim two different agent names in one apply_patch batch (each
  // looks free in isolation otherwise).
  let bindings = { ...(track.prdOwners ?? {}) };
  const taskFiles = inScope.some((c) => c.kind.kind === "agentReport") ? await readAllTaskFiles(root, homeSeg, router) : {};

  const binds: { agentId: string; name: string }[] = [];
  for (const { file, kind } of inScope) {
    let taskFile: PrdTaskFile | null = null;
    if (kind.kind === "agentReport") {
      const governing = governingTaskFile(kind.agent, taskFiles);
      taskFile = governing && identity.agentType !== undefined && identity.agentId !== undefined
        ? narrowForTarget(governing, identity.agentType, kind.agent, identity.agentId, bindings)
        : governing;
    }
    const verdict: PrdOwnershipVerdict = evaluateWriteOwnership({ kind, identity, taskFile, bindings });
    if (verdict.allow === false) return denyOutcome(id, event, trackFilePath, now, `${file}: ${verdict.reason}`);
    // Prevention: never let a write turn the VALID router invalid (underivable content is not judged).
    const turnsInvalid = kind.kind === "router" ? routerWriteViolation(event, patchTextOf(event, payload), snapshot.text, root, homeSeg) : null;
    if (turnsInvalid !== null) return denyOutcome(id, event, trackFilePath, now, `${file}: ${turnsInvalid}`);
    if (verdict.allow === true && verdict.bind) {
      binds.push(verdict.bind);
      bindings = { ...bindings, [verdict.bind.agentId]: verdict.bind.name };
    }
  }

  // A mixed envelope (some candidate files never classified in-scope by
  // classifyPrdPath, e.g. a genuinely unrelated file bundled into the SAME
  // apply_patch) must never ride THIS allow past applyPatchGate/gate() for
  // those other files — only a PURE-PRD envelope (every candidate file
  // in-scope) may short-circuit. A denial above (ownership violation on an
  // in-scope file) still fires regardless of mixing; only the ALLOW path is
  // restricted here, so it never becomes a silent bypass for an unclassified
  // file the PRD gate was never meant to authorize.
  if (inScope.length !== files.length) return null;

  if (binds.length > 0) {
    await withTrack(trackFilePath, (t) => binds.reduce((acc, b) => recordPrdOwner(acc, b.agentId, b.name), t));
  }
  return allowOutcome(id, event, payload, mcpDir, cwd, { trackFile: trackFilePath, now });
}

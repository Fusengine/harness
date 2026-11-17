/**
 * @module shadcn-skill-gate
 * Standalone shadcn/ui skill gate, ported from the shadcn-expert plugin's
 * `check-skill-loaded.py`. Distinct from the `*-shadcn` sub-skill entries
 * consumed by react/nextjs (`./skill-patterns/shadcn.ts`, the HTML-detection
 * patterns): this polices ANY Write/Edit in a shadcn-scoped path
 * (components|ui|shadcn|components.json), independent of the detected
 * `framework` — mirroring the plugin's own PreToolUse hook, which runs
 * alongside (not instead of) the react/nextjs framework gate.
 * @packageDocumentation
 */
import type { Prompt } from "../prompt/types";
import type { AuthEntry } from "../freshness/doc-helpers";
import { skillTriggerGate } from "./skill-triggers";
import { docConsultedGate } from "./apex";
import { isReleaseMetadataPath } from "./release-metadata-path";
import { projectRelativePath } from "./project-relative";

/** File extensions the shadcn gate polices (source: `\.(tsx|jsx|css|scss|json)$`). */
const SHADCN_FILE_RE = /\.(tsx|jsx|css|scss|json)$/;
/**
 * Vendored/build paths exempt from the gate. Uses `(^|\/)` (not just a
 * leading `/`) so a relative root-start path like `node_modules/x` is also
 * exempt — mirrors the same deliberate widening already applied in
 * `design/skill-gate.ts`'s `EXEMPT_RE`, not the Python's stricter `/x/`-only match.
 */
const EXEMPT_RE = /(^|\/)(node_modules|dist|build)\//;
/** Path fragments that put a write in shadcn scope (source: `(components|ui|shadcn|components\.json)`). */
const SHADCN_PATH_RE = /(components|ui|shadcn|components\.json)/;
/** A read reference proving one of the two named base skills was consulted (Phase 1). */
const SHADCN_BASE_SKILL_RE = /skills\/(shadcn-detection|shadcn-components)\//;
/** Session `authorizations` source proving a live `mcp__shadcn__*` call was made this session (Phase 1, option 3). */
const SHADCN_MCP_SOURCE_RE = /shadcn-mcp/i;

/** Session evidence the gate consumes: read references + doc authorizations. */
export interface ShadcnEvidence {
  refsRead: readonly string[];
  authorizations?: Record<string, AuthEntry>;
  sessionId: string;
}

/**
 * True when this Write/Edit is shadcn-scoped: a `.tsx/.jsx/.css/.scss/.json`
 * file under a `components|ui|shadcn|components.json` path, outside vendored
 * dirs. Ports `check-skill-loaded.py`'s file-path filter (lines 35-42).
 * @param projectRoot - Project root; when given, the path fragments are matched against the project-relative path only.
 */
export function isShadcnWrite(tool: string, filePath: string, projectRoot?: string): boolean {
  if (tool !== "Write" && tool !== "Edit") return false;
  if (!SHADCN_FILE_RE.test(filePath) || EXEMPT_RE.test(filePath)) return false;
  return SHADCN_PATH_RE.test(projectRelativePath(filePath, projectRoot));
}

/** True when `shadcn-detection/` or `shadcn-components/` was read this session (Phase 1 base skill). */
export function shadcnBaseSkillRead(refsRead: readonly string[]): boolean {
  return refsRead.some((p) => SHADCN_BASE_SKILL_RE.test(p));
}

/** True when a `mcp__shadcn__*` tool call was recorded this session (Phase 1's 3rd unblock option). */
export function shadcnMcpConsulted(authorizations: Record<string, AuthEntry> | undefined, sessionId: string): boolean {
  if (!authorizations) return false;
  return Object.values(authorizations).some(
    (a) => a.doc_sessions?.includes(sessionId) && (a.sources ?? (a.source ? [a.source] : [])).some((s) => SHADCN_MCP_SOURCE_RE.test(s)),
  );
}

/**
 * Gate a shadcn-scoped write. Phase 1 requires a base skill read
 * (shadcn-detection or shadcn-components); Phase 2 requires the domain
 * sub-skill(s) matching the written content, via {@link skillTriggerGate}
 * keyed on the "shadcn" framework (registered in `SKILL_TRIGGERS`); Phase 3
 * requires doc research, delegated to the existing {@link docConsultedGate}
 * (Context7 AND Exa, or a web fallback alone — not the Python's strict AND).
 * Returns a blocking {@link Prompt}, or `null` to allow.
 * @param projectRoot - Project root forwarded to {@link isShadcnWrite}.
 * @param hostId - Running host id (sub-skill paths printed are that host's own; absent = Claude Code, unchanged).
 */
export function shadcnSkillGate(
  tool: string,
  filePath: string,
  content: string,
  ev: ShadcnEvidence,
  projectRoot?: string,
  hostId?: string,
): Prompt | null {
  if (!isShadcnWrite(tool, filePath, projectRoot) || isReleaseMetadataPath(filePath)) return null;
  if (!shadcnBaseSkillRead(ev.refsRead) && !shadcnMcpConsulted(ev.authorizations, ev.sessionId)) {
    return {
      kind: "block",
      title: "shadcn/ui skill",
      reason: "BLOCKED: shadcn skill not consulted. Read shadcn-detection/SKILL.md or shadcn-components/SKILL.md, or use mcp__shadcn__search_items_in_registries, then retry.",
      actions: ["Read skills/shadcn-detection/ or skills/shadcn-components/, or call mcp__shadcn__search_items_in_registries, then retry"],
    };
  }
  const domainBlock = skillTriggerGate("shadcn", content, ev.refsRead, undefined, undefined, undefined, hostId);
  if (domainBlock) return domainBlock;
  return docConsultedGate({
    sessionId: ev.sessionId,
    framework: "shadcn",
    filePath,
    content,
    authorizations: ev.authorizations,
  });
}

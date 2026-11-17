import { resolveSessions, type AuthEntry } from "../freshness/doc-helpers";
import { routeReferences } from "../refs/router";
import { DEFAULT_TTL_SEC, ttlLabel } from "../config/ttl";
import { CONTEXT7_SOURCE, getSkillSource } from "./skill-source";
import { hostRoutedPaths } from "./host-skill-paths";
import type { ApexContext, ApexGate } from "./apex";

/** Pending doc-credit target written on a Check-1 deny (parity enforce-apex-phases.ts:80 `state.target`). */
export interface SessionTarget {
  project: string;
  framework: string;
  set_by: string;
  set_at: string;
}

/**
 * Credit a doc consultation onto one framework's auth entry (parity
 * track-doc-consultation.py): the once-per-session Check-2 fields
 * (`doc_sessions` + `sources`) plus the per-framework Check-1 stamp
 * (`sessions` + `doc_consulted`). Pure.
 */
export function creditDocConsultation(prev: AuthEntry | undefined, sessionId: string, source: string, nowIso: string): AuthEntry {
  const p = prev ?? {};
  const add = (list: string[], v: string): string[] => (v && !list.includes(v) ? [...list, v] : list);
  return {
    ...p,
    sessions: add(resolveSessions(p), sessionId),
    doc_sessions: add(p.doc_sessions ?? [], sessionId),
    sources: add(p.sources ?? (p.source ? [p.source] : []), source),
    doc_consulted: nowIso,
  };
}

/**
 * Check 1 (parity enforce-apex-phases.ts isAuthorized): the framework's doc or
 * skill was consulted in THIS session (resolveSessions) AND the stamp is
 * younger than the TTL (FUSE_ENFORCE_TTL_SEC via src/config/ttl.ts).
 */
export function isAuthorized(auth: AuthEntry | undefined, sessionId: string, now: number, ttlMs: number): boolean {
  if (!auth?.doc_consulted || !resolveSessions(auth).includes(sessionId)) return false;
  const readEpoch = Date.parse(auth.doc_consulted);
  return !Number.isNaN(readEpoch) && now - readEpoch < ttlMs;
}

/**
 * A fresh same-session `skills/**.md` read whose path names the framework also
 * satisfies Check 1 (parity track-doc-consultation.py, which stamps
 * `doc_consulted` on `skills/.*\.md` Reads; the harness records those Reads in
 * `refsRead`/`refsReadAt` instead, and the track file is per-session).
 */
function skillReadAuthorized(ctx: ApexContext, now: number, ttlMs: number): boolean {
  // Aliases keep every deny-promised path unblockable: laravel skills say "php",
  // and tailwind's SKILL.md lives under "tailwindcss[-v4]" where \btailwind\b
  // never matches (the boundary fails before the "c").
  const alias: Record<string, string> = { laravel: "laravel|php", tailwind: "tailwindcss?" };
  const nameRe = new RegExp(`\\b(${alias[ctx.framework] ?? ctx.framework})\\b`, "i");
  return (ctx.refsRead ?? []).some((p) => {
    if (!/skills\/.*\.md$/i.test(p) || !nameRe.test(p)) return false;
    const at = ctx.refsReadAt?.[p];
    return at !== undefined && now - at < ttlMs;
  });
}

/**
 * Gate (Check 1): deny until the framework's doc/skill is freshly consulted.
 * The deny lists the routed SOLID refs when refs are loaded (parity
 * formatRoutedDeny), else the framework's skill source (parity getSkillSource:
 * a real installed SKILL.md path, or the context7 consigne). The RUNTIME
 * caller persists `state.target` on deny (recordTarget, parity :80-81) so
 * recordDoc can cross-credit this framework on the next doc consultation.
 */
export const apexAuthorizationGate: ApexGate = (ctx) => {
  const windowMs = ctx.windowMs ?? DEFAULT_TTL_SEC * 1000;
  const now = ctx.now ?? Date.now();
  if (isAuthorized(ctx.authorizations?.[ctx.framework], ctx.sessionId, now, windowMs)) return null;
  if (skillReadAuthorized(ctx, now, windowMs)) return null;
  const ttl = ttlLabel(Math.round(windowMs / 1000));
  const title = `APEX: ${ctx.framework} documentation required`;
  const routed = ctx.refs?.length ? routeReferences(ctx.refs, ctx.filePath, ctx.content, "", ctx.framework) : null;
  if (!routed) {
    // Parity enforce-apex-phases.ts:82-87: getSkillSource (skill-source.ts)
    // resolves the REAL installed SKILL.md, or yields the context7 consigne —
    // never SOLID_REF's phantom `${PLUGINS_DIR}/generic/SKILL.md`.
    const src = getSkillSource(ctx.framework, undefined, ctx.hostId);
    return {
      kind: "block",
      title,
      reason: `APEX: Read doc first (expires every ${ttl}) for ${ctx.framework}! Source: ${src}`,
      actions: [src === CONTEXT7_SOURCE ? `Query ${CONTEXT7_SOURCE} for ${ctx.framework} docs` : `Read ${src}`],
    };
  }
  const hostPaths = hostRoutedPaths(routed, ctx, routed.required.map((r) => r.meta.filePath));
  const reason = [
    // H2b: name the full set (required + Optional) and invite the retry.
    `APEX: Read ALL SOLID references below (including Optional), then retry (expires every ${ttl}) for ${ctx.framework}.`,
    `Editing: ${ctx.filePath}`,
    ...(hostPaths.optional.length ? [`Optional: ${hostPaths.optional.join(", ")}`] : []),
    ...(hostPaths.skillPath === null ? [] : [`Full skill: ${hostPaths.skillPath}`]),
  ].join("\n");
  return { kind: "block", title, reason, actions: hostPaths.actions };
};

/**
 * @module design/skill-gate
 * UI design-skill gate — ports `check-design-skill.py` WITHOUT requiring Gemini.
 *
 * Fires for ANY agent writing a UI file (.tsx/.jsx/.scss/.vue/.svelte) in a
 * UI-ish path (or with Tailwind classes). Blocks unless BOTH: (1) a design skill
 * reference was read this session (reuses the `refsRead` track), and (2) both
 * Context7 AND Exa were consulted via {@link isDocConsulted}.
 * Gemini is NEVER a condition — doc research alone satisfies the gate.
 * @packageDocumentation
 */
import type { Prompt } from "../../prompt/types";
import { projectRelativePath } from "../project-relative";
import { missingDomainSkills } from "./skill-triggers";

/** UI source files the gate polices (.html/.css are handled by the pipeline gate, not here). */
const UI_FILE_RE = /\.(tsx|jsx|scss|vue|svelte)$/;
/** Generated/vendored paths that never need a design skill (match at start or mid-path). */
const EXEMPT_RE = /(^|\/)(node_modules|dist|build)\/|\.claude\//;
/** UI-intent path fragments (ports the Python `UI_PATH_PATTERNS`). */
const UI_PATH_RE = /(components|ui|styles|page|layout|content|view|feature|section|hero|footer|header|sidebar|nav|modal|dialog)/;
/** Tailwind utility usage in JSX `className` (ports the Python `has_jsx_tailwind`). */
const TAILWIND_RE = /className\s*=.*(?:flex|grid|p-|m-|bg-|text-|rounded|shadow|border|gap-|w-|h-)/;
/** A read reference path that counts as "a design skill was consulted". */
const DESIGN_SKILL_RE = /skills\/(design-method|design-system|design-web|design-webapp|design-motion|design-review|ux-copy|design-ios|design-android)/i;

/** Session evidence the gate consumes: read references + whether docs were consulted. */
export interface DesignEvidence {
  refsRead: readonly string[];
  docConsulted: boolean;
}

/**
 * True when this Write/Edit targets a UI file in a UI-ish path or with Tailwind classes.
 * @param projectRoot - Project root; when given, UI path fragments are matched against the project-relative path only.
 */
export function isUiWrite(tool: string, filePath: string, content: string, projectRoot?: string): boolean {
  if (tool !== "Write" && tool !== "Edit") return false;
  if (!UI_FILE_RE.test(filePath) || EXEMPT_RE.test(filePath)) return false;
  return UI_PATH_RE.test(projectRelativePath(filePath, projectRoot)) || TAILWIND_RE.test(content);
}

/** True when a design skill reference was read this session (scans the `refsRead` track). */
export function designSkillRead(refsRead: readonly string[]): boolean {
  return refsRead.some((p) => DESIGN_SKILL_RE.test(p));
}

const block = (reason: string, action: string): Prompt => ({
  kind: "block", title: "Design skill", reason, actions: [action],
});

/**
 * Gate a UI write: require a design-skill read AND any doc source. Returns a
 * blocking {@link Prompt}, or `null` to allow. NEVER requires Gemini.
 * @param tool - the tool name ("Write" | "Edit" | ...).
 * @param filePath - the written file path.
 * @param content - the written content (snippet on Edit, full file on Write).
 * @param ev - the session evidence (refsRead + docConsulted).
 * @param projectRoot - project root forwarded to {@link isUiWrite} (UI path fragments tested project-relative).
 */
export function uiDesignSkillGate(tool: string, filePath: string, content: string, ev: DesignEvidence, projectRoot?: string): Prompt | null {
  if (!isUiWrite(tool, filePath, content, projectRoot)) return null;
  if (!designSkillRead(ev.refsRead)) {
    return block(
      "BLOCKED: design skill not consulted before writing UI. Read a design SKILL.md "
      + "(design-system, design-web, or design-motion), then retry.",
      "Read a design skill reference, then retry",
    );
  }
  const missing = missingDomainSkills(content, ev.refsRead);
  if (missing.length) {
    return block(
      `BLOCKED: code uses ${missing.join(", ")} but the matching design skill(s) were not consulted. `
      + `Read the SKILL.md FILE (with the Read tool) for: ${missing.join(", ")}, then retry.`,
      `Read design skill(s): ${missing.join(", ")}, then retry`,
    );
  }
  if (!ev.docConsulted) {
    return block(
      "BLOCKED: no documentation consulted. Use BOTH mcp__context7__query-docs AND "
      + "mcp__exa__web_search_exa, or a web fallback alone (WebSearch/WebFetch). Gemini is NOT required.",
      "Consult Context7+Exa, or web docs alone (Gemini not required), then retry",
    );
  }
  return null;
}

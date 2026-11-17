import { basename } from "node:path";
import type { Prompt } from "../../prompt/types";
import { loadDesignState, type DesignState } from "./state";
import { activeDesignAgent } from "./flag";
import { isUiWrite } from "./skill-gate";
import { SKILL_TRIGGERS } from "./skill-triggers";
import { ALLOWED_WRITE, isAllowedWrite } from "./allowed-write";

export { validateDesignSystem } from "./design-system-rules";
export { ALLOWED_WRITE, isAllowedWrite } from "./allowed-write";

export const EXEMPT_DIRS: readonly string[] = ["node_modules/", "dist/", "build/", ".claude/"];
const NAV = "mcp__fuse-browser__browser_navigate";
const SHOT = "mcp__fuse-browser__browser_screenshot";
const GEMINI = "mcp__gemini-design__create_frontend";

export const deny = (reason: string): Prompt => ({
  kind: "block", title: "Design pipeline", reason,
  actions: ["Follow the design pipeline phases (0→identity, 1→inspiration, 2→screenshots, 3→design-system, 4→generate) in order"],
});

/** Block the design agent from writing anything but .html/.css/.md/.json (+ motion*.js). */
export function htmlCssOnlyGate(filePath: string): Prompt | null {
  if (EXEMPT_DIRS.some((d) => filePath.includes(d)) || isAllowedWrite(filePath)) return null;
  return deny(
    "BLOCKED: design-expert can only write .html, .css, .json, .md, and motion*.js files. " +
      "Framework files (.tsx, .astro, .vue, .swift, .php) must be written by the domain expert " +
      "(astro-expert, react-expert, etc.) AFTER design validation.",
  );
}

/** Block edits to the harness-managed `.design-state-*` files (read-only to the agent). */
export function stateFileGate(filePath: string): Prompt | null {
  return filePath.includes(".design-state-")
    ? deny(
        "BLOCKED: .design-state files are READ-ONLY for you. Hooks update them automatically as you progress. " +
          "Do NOT try to modify them — it will not unblock you. Follow the pipeline: Phase 0→1→2→3→4→5→6 in order.",
      )
    : null;
}

/** Gate a screenshot: require a scroll since the last navigate (lazy-load content). */
export function screenshotScrollGate(state: DesignState): Prompt | null {
  return state.scrolledSinceNav
    ? null
    : deny("BLOCKED: scroll the page before a screenshot — browser_scroll to:'end', wait, scroll back, then fullPage screenshot.");
}

/** The Gemini design gates are OPT-IN: off unless `FUSE_DESIGN_GEMINI` is `1`/`true`. */
export function geminiEnabled(): boolean {
  const v = process.env.FUSE_DESIGN_GEMINI;
  return v === "1" || v === "true";
}

/** Inputs for {@link designPassNotice} — primitives only, so policy stays runtime-free. */
export interface PassNoticeInput { agentId: string; tool: string; filePath: string; content: string; url: string; phase: "pre" | "post"; projectRoot?: string }

/**
 * Python-parity pass notices (`hook_output.allow_pass`/`post_pass`): the
 * user-visible `script: detail` lines the old plugins printed on EVERY passing
 * design hook. Call AFTER the gates allowed the event; returns an `inform`
 * Prompt carrying only `userMessage` (for the human, never agent context), or
 * null when nothing applies. The check-design-skill line fires for ANY agent
 * on a UI write; the rest only inside the active design-agent context.
 */
export function designPassNotice(i: PassNoticeInput & { corpusMissing?: boolean }, cacheDir: string): Prompt | null {
  const isWrite = i.tool === "Write" || i.tool === "Edit";
  const fp = i.filePath;
  const lines: string[] = [];
  if (i.phase === "pre" && isUiWrite(i.tool, fp, i.content, i.projectRoot)) {
    const domains = SKILL_TRIGGERS.filter((t) => t.patterns.some((re) => re.test(i.content))).map((t) => t.skill).join(", ");
    lines.push(`check-design-skill: pass (domain: ${domains || "base"})`);
  }
  const state = i.agentId && activeDesignAgent(cacheDir) === i.agentId ? loadDesignState(cacheDir, i.agentId) : null;
  if (state && i.phase === "pre") {
    if (i.corpusMissing) lines.push("design-corpus: refs-design corpus not found — corpus requirement waived (screenshot-only fallback, install defect)");
    if (isWrite && fp && !EXEMPT_DIRS.some((d) => fp.includes(d)) && ALLOWED_WRITE.test(fp)) lines.push(`enforce-html-css-only: allowed: ${basename(fp)}`);
    if (i.tool === NAV) lines.push(`check-inspiration-read: pass (${i.url})`);
    if (i.tool === GEMINI && geminiEnabled()) lines.push("validate-design-system: design-system.md ok");
    if (isWrite || i.tool === NAV || i.tool === SHOT || i.tool === GEMINI) lines.push(`pipeline-gate: phase ${state.currentPhase} ok`);
  }
  if (state && i.phase === "post" && isWrite) {
    if (basename(fp) === "design-system.md") lines.push("validate-design: design-system.md → phase 3");
    else if (/\.(tsx|jsx|css)$/.test(fp)) lines.push("validate-design: design ok");
  }
  return lines.length ? { kind: "inform", title: "Design pipeline", reason: "", userMessage: lines.join("\n") } : null;
}

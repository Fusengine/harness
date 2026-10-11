import type { Prompt } from "../../prompt/types";
import { type DesignMode, type DesignState, quotaFor } from "./state";
import { corpusReady } from "./corpus";
import { PLUGINS_DIR } from "../file-size";
import { deny } from "./gates";
import { isTemplateUrl } from "./template-urls";

const SKILLS = `${PLUGINS_DIR}/design-expert/skills`;

/** Per-mode corpus-read requirement spelled out for refusal texts (MIRRORS `corpusReady` — display only, thresholds unchanged). */
const CORPUS_NEED: Readonly<Record<DesignMode, string>> = {
  component: "1 corpus file",
  page: "2 corpus files",
  full: "README.md + 3 tokens-*.md files",
};

/**
 * The unmet phase-2 requirements, one entry per gap: corpus reads credited at
 * the CREDITED root (with its path) when the corpus is delivered, and the
 * screenshot count as taken/required (N/M). A satisfied requirement is simply
 * absent from the list, so the refusal names exactly what is missing.
 */
function missingRequirements(state: DesignState, corpusRequired: boolean, corpusRoot: string): string[] {
  const missing: string[] = [];
  if (corpusRequired && !corpusReady(state.corpusReads, state.mode)) {
    missing.push(`corpus reads: ${state.corpusReads.length} credited under '${corpusRoot}' (required: ${CORPUS_NEED[state.mode]})`);
  }
  const needed = quotaFor(state.mode, corpusRequired);
  if (state.screenshotsCount < needed) {
    missing.push(`screenshots: ${state.screenshotsCount}/${needed} (any fuse-browser capture counts — browser_screenshot, browser_shots_batch, browser_site_shots)`);
  }
  return missing;
}

/** Gate writing design-system.md: requires phase >= 2 and the per-mode screenshot quota. The refusal lists exactly what is missing. */
export function designSystemWriteGate(filePath: string, state: DesignState, corpusRequired = false, corpusRoot = ""): Prompt | null {
  if (!filePath.endsWith("design-system.md")) return null;
  if (state.currentPhase < 2) {
    const missing = missingRequirements(state, corpusRequired, corpusRoot);
    return deny(
      `BLOCKED: Cannot write design-system.md at phase ${state.currentPhase}. Missing: ${missing.join("; ") || "phase-2 requirements"}. ` +
        "RECOVERY: 1) Read identity templates from skills/design-system/ " +
        "2) Read design-inspiration.md 3) Read the refs-design corpus (README.md + relevant tokens-*.md) with the Read tool " +
        "4) Capture real sector sites with any fuse-browser screenshot tool (browser_screenshot, browser_shots_batch, browser_site_shots — 1 credit per call) " +
        "5) Then write design-system.md",
    );
  }
  const needed = quotaFor(state.mode, corpusRequired);
  if (state.screenshotsCount < needed) {
    return deny(
      `BLOCKED: ${state.screenshotsCount}/${needed} screenshots for mode '${state.mode}'. ` +
        `RECOVERY: take ${needed - state.screenshotsCount} more capture(s) with any fuse-browser screenshot tool ` +
        "(browser_screenshot, browser_shots_batch, browser_site_shots — 1 credit per call), then write design-system.md",
    );
  }
  return null;
}

/**
 * Gate writing .html/.css: PIPELINE gate (never `uiDesignSkillGate`/`UI_FILE_RE`
 * — owner-scoped out of the skill gate's remit). Requires phase >= 3 AND
 * designSystemValid (same two-condition defense as {@link geminiCreateGate})
 * AND `designSystemFileExists` (caller-computed via `findDesignSystem` — a
 * state can say phase 3 after the file was later deleted, or the file can
 * exist while a fresh agent's state is still phase 0).
 */
export function htmlCssPipelineGate(filePath: string, state: DesignState, designSystemFileExists: boolean): Prompt | null {
  if (!/\.(html|css)$/.test(filePath)) return null;
  if (state.currentPhase >= 3 && state.designSystemValid && designSystemFileExists) return null;
  const gaps: string[] = [];
  if (state.currentPhase < 3) gaps.push(`phase ${state.currentPhase}/3`);
  if (!state.designSystemValid) gaps.push("design-system.md not validated");
  if (!designSystemFileExists) gaps.push("design-system.md not found on disk");
  return deny(
    `BLOCKED: cannot write '${filePath}' before the design-system pipeline is complete (${gaps.join(", ")}). ` +
      "RECOVERY: 1) Read identity templates from skills/design-system/ 2) Read design-inspiration.md " +
      "3) Read the refs-design corpus with the Read tool 4) Capture real sector sites with any fuse-browser " +
      "screenshot tool (browser_screenshot, browser_shots_batch, browser_site_shots) 5) Write a valid design-system.md " +
      "6) Then write .html/.css",
  );
}

/** Gate Gemini create_frontend: requires phase >= 3 and a validated design system. */
export function geminiCreateGate(state: DesignState): Prompt | null {
  if (state.currentPhase < 3) {
    return deny(
      "BLOCKED: Cannot call Gemini create_frontend before phase 3. " +
        "RECOVERY: 1) Complete the inspiration phase (refs-design corpus + sector screenshots) 2) Write a valid design-system.md " +
        "3) Then call mcp__gemini-design__create_frontend",
    );
  }
  if (!state.designSystemValid) {
    return deny(
      "BLOCKED: design-system.md not validated. " +
        "RECOVERY: 1) Ensure design-system.md has ## Design Reference, OKLCH tokens, typography pair, reference URL or Corpus citation " +
        "2) Then retry mcp__gemini-design__create_frontend",
    );
  }
  return null;
}

/**
 * Gate fuse-browser navigate: phase >= 1, inspiration read, no template source in phase 1.
 * The allowlist→denylist inversion is the DELIBERATE doctrine change (not a
 * weakening): the gate was never the proof — the mandatory screenshot is,
 * unchanged and unforgeable in both configurations. Corpus-absent has its
 * counterpart already (pre-doctrine quotas + visible warning); what the
 * denylist cannot cover (sector-browse quality) belongs to the doc, per the
 * rule "the gate requires what is verifiable, the doc prescribes zeal".
 */
export function browserNavigateGate(state: DesignState, url: string): Prompt | null {
  if (state.currentPhase < 1) {
    return deny(`BLOCKED: Phase 0 not done. READ: ${SKILLS}/design-system/SKILL.md first.`);
  }
  if (!state.inspirationRead) {
    return deny(
      `BLOCKED: Read the inspiration doctrine first. READ: ${SKILLS}/design-web/references/design-inspiration.md, then the refs-design corpus (README.md + relevant tokens-*.md) with the Read tool`,
    );
  }
  if (state.currentPhase === 1 && url && isTemplateUrl(url)) {
    return deny(
      `BLOCKED: '${url}' is a template source — templates are BUILT to be interchangeable, ` +
        "so extracting taste from them converges every page to the same body. " +
        "RECOVERY: 1) taste comes from the refs-design corpus (README.md + relevant tokens-*.md) " +
        "2) browse 1-2 REAL sites in the client's sector, for register only (award galleries are fine as outbound-link finders)",
    );
  }
  return null;
}

import type { Prompt } from "../prompt/types";
import type { NormalizedEvent } from "./normalize";
import { loadDesignState, saveDesignState, initDesignState } from "../policy/design/state";
import { recordValidDesignSystem } from "../policy/design/transitions";
import { activeDesignAgent } from "../policy/design/flag";
import { runDesignChecks } from "../policy/design/content-checks";
import { uiDesignSkillGate } from "../policy/design/skill-gate";
import { collectDesignEvidence } from "../policy/design/skill-evidence";
import { findDesignSystem, findDesignSystemForFile, recordPost, designSystemContentGate } from "./design-helpers";
import { checkDesignSystemContent } from "./design-content-gate";
import { designFilesGate } from "./design-files-gate";
import { resolveCorpusRoot, resolvePluginsRoot, pluginsWriteGuard } from "../policy/design/corpus";
import {
  htmlCssOnlyGate, stateFileGate, screenshotScrollGate,
  geminiEnabled,
} from "../policy/design/gates";
import { designSystemWriteGate, geminiCreateGate, browserNavigateGate, htmlCssPipelineGate } from "../policy/design/gates-pipeline";

const NAV = "mcp__fuse-browser__browser_navigate";
const SHOT = "mcp__fuse-browser__browser_screenshot";
const GEMINI = "mcp__gemini-design__create_frontend";

/**
 * Design-pipeline gate (effectful: reads/writes the design state + design-system.md).
 * Returns a Prompt to block, or null when this isn't a design-agent context / nothing fires.
 */
export function designGate(payload: Record<string, unknown>, event: NormalizedEvent, cacheDir: string, cwd: string, corpusRootOverride?: string, pluginsRootOverride?: string): Prompt | null {
  // UI design-skill gate (ports check-design-skill.py): fires for ANY agent on a
  // UI write — requires a design-skill read + ANY doc source (Context7/Exa/web).
  // Gemini is NEVER required. Runs before the design-agent pipeline state logic.
  if (event.phase !== "post" && (event.tool === "Write" || event.tool === "Edit")) {
    const skillBlock = uiDesignSkillGate(event.tool, event.filePath ?? "", event.content ?? "", collectDesignEvidence(event.sessionId, cwd));
    if (skillBlock) return skillBlock;
  }
  // Codex apply_patch parity (D2 gap, docstring design-files-gate.ts:17-24): the
  // same UI write can arrive fanned into event.files instead of a single
  // Write/Edit. Map each non-delete file to its Write/Edit-equivalent tool
  // ("add" -> Write, "update" -> Edit) and run the SAME gate, so the skill
  // requirement cannot be bypassed just by routing the write through apply_patch.
  // Scope matches the Write/Edit block above: ANY agent, before the agentId
  // early-return — never narrowed to design-agent-only.
  if (event.phase !== "post" && event.files && event.files.length > 0) {
    const evidence = collectDesignEvidence(event.sessionId, cwd);
    for (const f of event.files) {
      if (f.op === "delete") continue;
      const skillBlock = uiDesignSkillGate(f.op === "add" ? "Write" : "Edit", f.filePath, f.content, evidence);
      if (skillBlock) return skillBlock;
    }
  }

  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "";
  if (!agentId) return null; // top-level (lead) calls are never design-agent-scoped
  const active = activeDesignAgent(cacheDir);
  if (active && agentId !== active) return null;
  const id = agentId;
  // P5 fail-open fix: when the design flag is active but the state file is missing
  // (e.g. teammate context), auto-init a fresh state instead of disabling all
  // gating (parity with pipeline-gate.py:38-60). Without the flag, stay inert.
  let state = loadDesignState(cacheDir, id);
  if (!state) {
    if (!active) return null;
    // dd8a2e1 parity (passe 3): the SESSION mode/quota is decided by the cwd
    // walk ONLY — never by the first event's filePath (a Read/Grep/Write under
    // a sub/ holding a design-system.md must not flip the session to "page").
    // The per-file resolver (findDesignSystemForFile) stays at the write gates.
    const dsExists = findDesignSystem(cwd) !== "";
    state = initDesignState(id, dsExists ? "page" : "full", dsExists);
    saveDesignState(cacheDir, state);
  }
  // Corpus + plugin roots, resolved INDEPENDENTLY (corpusRoot never decides
  // pluginsRoot — F4). Corpus absent ⇒ requirement waived (pre-doctrine quotas);
  // the plugin-root write guard stays active against refs-design fabrication.
  const corpusRoot = corpusRootOverride ?? resolveCorpusRoot();
  const corpusRequired = corpusRoot !== "";
  const pluginsRoot = pluginsRootOverride ?? resolvePluginsRoot();

  if (event.phase === "post") {
    recordPost(event, cacheDir, state, corpusRoot, corpusRequired, cwd);
    if ((event.tool === "Write" || event.tool === "Edit") && /\.(tsx|jsx|css)$/.test(event.filePath ?? "")) {
      const warnings = runDesignChecks(event.content ?? "");
      if (warnings.length) return { kind: "inform", title: "Design review", reason: warnings.join(" "), actions: [] };
    }
    return null;
  }
  if (event.tool === "Write" || event.tool === "Edit") {
    const fp = event.filePath ?? "";
    // Parity: only design-system.md is screenshot-quota-gated (designSystemWriteGate).
    const base = pluginsWriteGuard(fp, pluginsRoot) ?? stateFileGate(fp) ?? htmlCssOnlyGate(fp)
      ?? htmlCssPipelineGate(fp, state, findDesignSystemForFile(cwd, fp) !== "") ?? designSystemWriteGate(fp, state, corpusRequired, corpusRoot)
      ?? designSystemContentGate({ filePath: fp, tool: event.tool, content: event.content ?? "", oldString: event.oldString, replaceAll: event.input.replace_all === true, state, corpusRoot, corpusRequired });
    if (base) return base;
    if (geminiEnabled() && state.geminiCalls === 0 && /\.(html|css)$/.test(fp)) {
      return { kind: "block", title: "Design pipeline", reason: "BLOCKED: generate the frontend via create_frontend before hand-writing HTML/CSS.", actions: ["Call mcp__gemini-design__create_frontend first"] };
    }
    return null;
  }
  // Codex apply_patch (D2): gate each fanned-out file like a Write. The
  // design-system.md lookup is PER FILE (passe 2): each patched file gets the
  // verdict it would get written alone — resolving once from the first file
  // let a found (or missing) design-system.md leak onto the whole envelope.
  if (event.files && event.files.length > 0) {
    return designFilesGate(event.files, state, pluginsRoot, corpusRoot, corpusRequired, cwd, (fp) => findDesignSystemForFile(cwd, fp) !== "");
  }
  if (event.tool === NAV) {
    return browserNavigateGate(state, typeof event.input.url === "string" ? event.input.url : "");
  }
  if (event.tool === SHOT) return screenshotScrollGate(state);
  if (event.tool === GEMINI) {
    if (!geminiEnabled()) return null;
    const block = geminiCreateGate(state);
    if (block) return block;
    const ds = findDesignSystem(cwd);
    // Parity validate-design-system.py DENY_NOT_FOUND: a MISSING file gets its own
    // recovery message, distinct from the "too generic" message for a present-but-thin one.
    if (ds === "") {
      return { kind: "block", title: "Design pipeline", reason: "BLOCKED: design-system.md not found. RECOVERY: 1) Read the identity templates 2) Read design-inspiration.md 3) Read the refs-design corpus (README.md + relevant tokens-*.md) 4) Capture 1-2 real sector sites with any fuse-browser screenshot tool (browser_screenshot, browser_shots_batch, browser_site_shots) 5) Write design-system.md, then retry create_frontend.", actions: ["Create design-system.md via the pipeline, then retry create_frontend"] };
    }
    // Same content rules as the nominal write path (jointure included): the
    // Gemini branch must not be weaker than the gate the Write just went through.
    const contentBlock = checkDesignSystemContent(ds, state.corpusReads, corpusRequired);
    if (contentBlock) return contentBlock;
    saveDesignState(cacheDir, recordValidDesignSystem(state));
  }
  return null;
}

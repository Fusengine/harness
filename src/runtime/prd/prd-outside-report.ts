/**
 * @module prd-outside-report
 * Path rule for PRD agent reports written OUTSIDE the host's PRD tree. A report
 * is `<root>/<homeSeg>/apex/prd/agents/<agent>-prd.json`; an executor given the
 * relative text `prd/agents/…` used to write `<project>/prd/agents/…`, a path
 * `classifyPrdPath` never saw (null) — so no PRD check ran at all. This
 * denies a `<name>-prd.json` write ONLY when its parent dir is exactly
 * `<root>/prd/agents` or `<payload cwd>/prd/agents` (the bug shape), naming the
 * correct absolute path. Any other lookalike (fixtures, docs, backups, another
 * host's tree) and any delete is left alone.
 * Path rule, not identity: applies to the lead and every sub-agent, on every
 * host. Relative targets resolve against the payload cwd (Codex resolves
 * `apply_patch` paths against it; Kimi's path form is undocumented).
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { HOME_DIR } from "../../config/dotenv";
import { shellFileWriteRedirects } from "../../policy/guards/bash-write-redirects";
import { prdAgentReportPath } from "../../policy/prd";
import type { NormalizedEvent } from "../normalize";
import type { OutsideReportInput } from "./interfaces/outside-report";
import { extraBashWriteTargets } from "./prd-bash-targets";
import { canonicalFilePath } from "./prd-canon";

const SUFFIX = "-prd.json";
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * The deny reason for the first target that looks like a PRD agent report but
 * sits outside `<root>/<homeSeg>/apex/prd/agents/`, or `null` when none does.
 * @param input - Targets plus the resolution context.
 */
export function outsideReportDeny(input: OutsideReportInput): string | null {
  const { targets, base, root, homeSeg } = input;
  const agentsDir = dirname(prdAgentReportPath(root, homeSeg, "x"));
  // Same representation as the canonicalized targets (a symlinked home segment would otherwise never match).
  const canonAgentsDir = canonicalFilePath(agentsDir);
  // The bug shape ONLY: `prd/agents` directly under the project root or the payload cwd.
  const buggyDirs = new Set([canonicalFilePath(resolve(root, "prd", "agents")), canonicalFilePath(resolve(base, "prd", "agents"))]);
  buggyDirs.delete(canonAgentsDir);
  // Every host's real reports folder is a legitimate target, never the bug shape (cwd may sit in another host's apex dir).
  for (const seg of Object.values(HOME_DIR)) buggyDirs.delete(canonicalFilePath(dirname(prdAgentReportPath(root, seg, "x"))));
  for (const raw of targets) {
    const abs = canonicalFilePath(resolve(base, raw));
    const name = basename(abs);
    if (!name.endsWith(SUFFIX) || name.length === SUFFIX.length) continue;
    if (!buggyDirs.has(dirname(abs))) continue;
    const agent = name.slice(0, -SUFFIX.length);
    return `${abs} is outside ${agentsDir} — write your PRD report to ${prdAgentReportPath(root, homeSeg, agent)}`;
  }
  return null;
}

/** Every write target of a hook event: apply_patch files, Write/Edit/MultiEdit path, Bash redirect + verb targets. */
function writeTargetsOf(event: NormalizedEvent): string[] {
  // Deletes are not writes (cleaning up a misplaced report must stay possible).
  if (event.files?.length) return event.files.filter((f) => f.op !== "delete").map((f) => f.filePath);
  if (event.tool === "Bash" && event.command) {
    return [...shellFileWriteRedirects(event.command).map((r) => r.target), ...extraBashWriteTargets(event.command)];
  }
  return event.filePath && FILE_TOOLS.has(event.tool) ? [event.filePath] : [];
}

/**
 * {@link outsideReportDeny} for a normalized hook event.
 * @param event - The hook event (its payload `cwd` is the base for relative targets).
 * @param root - Canonical project root.
 * @param homeSeg - Host home-dir segment.
 */
export function eventOutsideReportDeny(event: NormalizedEvent, root: string, homeSeg: string): string | null {
  const base = event.cwd && isAbsolute(event.cwd) ? event.cwd : root;
  return outsideReportDeny({ targets: writeTargetsOf(event), base, root, homeSeg });
}

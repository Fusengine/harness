import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../util/json-io";
import { fuseHarnessHome } from "../home-state";
import { projectHash } from "../paths";

/** SubagentStop timestamps (epoch ms) of the last sniper / challenger report. */
export interface ReviewReports {
  sniper: number;
  challenger: number;
}

const SNIPER = /(?:^|:)sniper$/;
const CHALLENGER = /(?:^|:)challenger$/;

function reportsFile(projectDir: string, home?: string): string {
  return join(fuseHarnessHome(home), "state", projectHash(projectDir), "release-gate.json");
}

/**
 * Read the stored review-report timestamps of a project (zeros when none).
 * @param projectDir - Resolved project dir.
 * @param home - Test-only home override.
 */
export function readReviewReports(projectDir: string, home?: string): ReviewReports {
  try {
    const raw = JSON.parse(readFileSync(reportsFile(projectDir, home), "utf8")) as Partial<ReviewReports>;
    return { sniper: Number(raw.sniper) || 0, challenger: Number(raw.challenger) || 0 };
  } catch {
    return { sniper: 0, challenger: 0 };
  }
}

/**
 * Record a finished sniper/challenger sub-agent (SubagentStop payload `agent_type`).
 * Other agent types (and `sniper-faster`) are ignored. Never throws.
 * @param payload - The SubagentStop payload.
 * @param projectDir - Resolved project dir.
 * @param now - Epoch ms.
 * @param home - Test-only home override.
 */
export function recordReviewReport(payload: Record<string, unknown>, projectDir: string, now: number, home?: string): void {
  const type = typeof payload.agent_type === "string" ? payload.agent_type : "";
  const key = SNIPER.test(type) ? "sniper" : CHALLENGER.test(type) ? "challenger" : null;
  if (!key) return;
  try {
    const prev = readReviewReports(projectDir, home);
    atomicWrite(reportsFile(projectDir, home), JSON.stringify({ ...prev, [key]: Math.max(prev[key], now) }));
  } catch {
    /* state-io failure: the gate then asks, never crashes the hook */
  }
}

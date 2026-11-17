/**
 * @module one-shot-summary
 * Compact injectable one-shot summary line ({@link module:one-shot-store}).
 * @packageDocumentation
 */
import type { OneShotState } from "./one-shot-types";

/**
 * Compact injectable summary (one line); "" when there is nothing to report.
 * `Nfix` counts denies later cleared by an allow of the same op OR (Bash-write
 * denies) by a Write/Edit on the denied target file.
 * @returns e.g. `gates 7d: 88% one-shot (44/50 clean); SOLID file-size limit 4den/3fix`.
 */
export function formatSummary(s: OneShotState): string {
  const keys = Object.keys(s.gates);
  const total = s.firstTry + s.corrected;
  if (keys.length === 0 && total === 0) return "";
  const head = total > 0 ? `${Math.round((s.firstTry / total) * 100)}% one-shot (${s.firstTry}/${total} clean)` : "no clean pass yet";
  const parts = keys
    .map((k) => ({ k, g: s.gates[k]! }))
    .sort((a, b) => b.g.denies - a.g.denies)
    .map(({ k, g }) => `${k} ${g.denies}den/${g.corrected}fix`);
  return `gates 7d: ${head}${parts.length ? `; ${parts.join("; ")}` : ""}`;
}

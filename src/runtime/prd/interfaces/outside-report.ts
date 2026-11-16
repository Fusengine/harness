/** Types for the outside-report path rule (`../prd-outside-report.ts`). */

/** Inputs of `outsideReportDeny`. */
export interface OutsideReportInput {
  /** Raw write targets (Write/Edit/apply_patch paths, Bash redirect/verb targets). */
  targets: string[];
  /** Directory relative targets resolve against: the payload cwd when absolute, else the project root. */
  base: string;
  /** Canonical project root. */
  root: string;
  /** Host home-dir segment (e.g. `.codex`). */
  homeSeg: string;
}

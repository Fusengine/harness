/**
 * @module security/scan/coverage
 * Accumulates what the scan covered and skipped, and builds the `coverage` block.
 * @packageDocumentation
 */
import { PATTERN_SET_VERSION } from "./constants";
import type { Coverage, ScanLimits, SkippedCounts } from "./types";

const MAX_PROJECTS = 100;
const MAX_UNSUPPORTED = 10;

/** Mutable collector; call {@link CoverageBuilder.finalize} once at the end. */
export class CoverageBuilder {
  private readonly files: Record<string, number> = {};
  private readonly patterns: Record<string, number> = {};
  private readonly unsup: Record<string, number> = {};
  private readonly projects: { root: string; marker: string }[] = [];
  private bytes = 0;
  readonly skipped: SkippedCounts = {
    excludedDirs: 0, binary: 0, minified: 0, oversize: 0, unreadable: 0,
    lockfiles: 0, generated: 0, longLines: 0, capped: false,
  };

  /** Record one scanned file of kind `lang`; `patternsApplied` keeps the max `patternCount` over the kind's files. */
  addFile(lang: string, bytes: number, patternCount: number): void {
    this.files[lang] = (this.files[lang] ?? 0) + 1;
    this.patterns[lang] = Math.max(this.patterns[lang] ?? 0, patternCount);
    this.bytes += bytes;
  }

  /** Record a known-but-unsupported code extension. */
  addUnsupported(ext: string): void { this.unsup[ext] = (this.unsup[ext] ?? 0) + 1; }

  /** Record a project marker directory (capped). */
  addProject(root: string, marker: string): void {
    if (this.projects.length < MAX_PROJECTS) this.projects.push({ root, marker });
  }

  /** Build the final block. `primaryLanguage` = source language with the most files. */
  finalize(limits: ScanLimits): Coverage {
    const langs = Object.keys(this.files).sort((a, b) => (this.files[b] ?? 0) - (this.files[a] ?? 0) || a.localeCompare(b));
    const primary = langs.find((l) => l !== "text") ?? "unknown";
    const unsupported = Object.fromEntries(
      Object.entries(this.unsup).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_UNSUPPORTED),
    );
    const total = Object.values(this.files).reduce((a, b) => a + b, 0);
    return {
      patternSetVersion: PATTERN_SET_VERSION, primaryLanguage: primary, languages: langs,
      filesScanned: Object.fromEntries(langs.map((l) => [l, this.files[l] ?? 0])),
      patternsApplied: Object.fromEntries(langs.map((l) => [l, this.patterns[l] ?? 0])),
      totals: { files: total, bytes: this.bytes }, projects: this.projects,
      skipped: this.skipped, unsupported, limits,
    };
  }
}

/**
 * @module security/scan/filter
 * Reads a candidate file and applies the skip rules (lockfile, minified,
 * oversize, binary). Files the pre-coverage scanner read (the root-detected
 * language's extension, `LEGACY_EXT`) bypass EVERY skip rule so none of their
 * legacy findings can vanish.
 * @packageDocumentation
 */
import { readFileSync, statSync } from "node:fs";
import { LOCKFILES, MINIFIED_NAME_RE } from "./constants";
import type { ScanLimits, SkippedCounts } from "./types";

/** Skip reasons that carry a counter. */
export type SkipReason = Exclude<keyof SkippedCounts, "capped" | "longLines" | "excludedDirs" | "generated">;

/** Result of {@link readCandidate}: text to scan, or the reason it was skipped. */
export type Candidate = { text: string; bytes: number } | { skip: SkipReason };

/** Average line length above which a large file is treated as minified. */
const MINIFIED_AVG_LINE = 300;
const MINIFIED_MIN_BYTES = 8192;

/**
 * Read `path` and decide whether it should be scanned.
 * @param path - absolute file path
 * @param name - base name
 * @param limits - size limits (ignored for legacy-read files)
 * @param legacy - the legacy scanner read this file (root-language extension): bypass every skip rule
 */
export function readCandidate(path: string, name: string, limits: ScanLimits, legacy: boolean): Candidate {
  if (!legacy) {
    if (LOCKFILES.has(name)) return { skip: "lockfiles" };
    if (MINIFIED_NAME_RE.test(name)) return { skip: "minified" };
  }
  let buf: Buffer;
  try {
    if (!legacy && statSync(path).size > limits.maxFileBytes) return { skip: "oversize" };
    buf = readFileSync(path);
  } catch { return { skip: "unreadable" }; }
  if (legacy) return { text: buf.toString("utf8"), bytes: buf.length };
  if (buf.subarray(0, 8000).includes(0)) return { skip: "binary" };
  const text = buf.toString("utf8");
  if (buf.length >= MINIFIED_MIN_BYTES && buf.length / (text.split("\n").length) > MINIFIED_AVG_LINE) return { skip: "minified" };
  return { text, bytes: buf.length };
}

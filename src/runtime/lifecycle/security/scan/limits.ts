/**
 * @module security/scan/limits
 * Env-tunable scan limits. Defaults are derived from measurement (see
 * docs/security-scan.md): hand-written source is far below 1 MiB per file and
 * 4096 chars per line, while bundles/data dumps exceed both.
 * @packageDocumentation
 */
import { parseEnvInt } from "../../../../config/env";
import type { ScanLimits } from "./types";

/** Default limits. */
export const DEFAULT_LIMITS: ScanLimits = {
  maxFileBytes: 1024 * 1024, maxLineChars: 4096, maxFiles: 50_000, maxTotalBytes: 256 * 1024 * 1024,
};

/**
 * Resolve scan limits from env (`FUSE_SCAN_MAX_FILE_BYTES`, `FUSE_SCAN_MAX_LINE_CHARS`,
 * `FUSE_SCAN_MAX_FILES`, `FUSE_SCAN_MAX_TOTAL_BYTES`); invalid values fall back.
 * @param env - environment map (defaults to `process.env`)
 */
export function resolveScanLimits(env: Record<string, string | undefined> = process.env): ScanLimits {
  return {
    maxFileBytes: parseEnvInt(env.FUSE_SCAN_MAX_FILE_BYTES, DEFAULT_LIMITS.maxFileBytes),
    maxLineChars: parseEnvInt(env.FUSE_SCAN_MAX_LINE_CHARS, DEFAULT_LIMITS.maxLineChars),
    maxFiles: parseEnvInt(env.FUSE_SCAN_MAX_FILES, DEFAULT_LIMITS.maxFiles),
    maxTotalBytes: parseEnvInt(env.FUSE_SCAN_MAX_TOTAL_BYTES, DEFAULT_LIMITS.maxTotalBytes),
  };
}

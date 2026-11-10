/**
 * Bounded file reads for the cartographer: a description needs the head of a
 * file, never all of it (#121: a multi-GiB file was read whole on every
 * SessionStart). Also guards the index/sidecar reads of the merge step.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseEnvInt } from "../../../config/env";

/** Files up to this size are read whole, exactly as before (1 MiB); larger ones contribute a prefix of this size. */
export const DEFAULT_CARTO_FULL_READ_MAX_BYTES: number = 1024 * 1024;
/** Max length of any string kept from a plugin file (names, descriptions, versions, hook events). */
export const MAX_PLUGIN_STRING = 200;
/** Head inspected for a binary signature before decoding a prefix. */
const SNIFF_BYTES = 8 * 1024;
const PDF_MAGIC = "%PDF-";

/** Text read for a description; `truncated` is true when only a prefix of a larger file was read. */
export interface DescriptionSource {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Resolve the whole-file read cap (`FUSE_CARTO_FULL_READ_MAX_BYTES`, default
 * 1 MiB; absent/invalid falls back to the default).
 * @param env - environment map (defaults to `process.env`)
 * @returns The cap in bytes (a positive integer).
 */
export function resolveCartoFullReadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  return parseEnvInt(env.FUSE_CARTO_FULL_READ_MAX_BYTES, DEFAULT_CARTO_FULL_READ_MAX_BYTES);
}

/**
 * Copy of a short string that does not keep its source alive. `slice` results are
 * views on the parent string in JS engines, so a 60-char description cut from a
 * 1 MiB file would pin the whole file in memory for as long as the description lives.
 * @param s - A (short) string that may be a view on a large one.
 * @returns A standalone copy with the same content.
 */
export function detach(s: string): string {
  return s.length > 0 ? Array.from(s).join("") : s;
}

/**
 * Cap an untrusted string read from a plugin file to {@link MAX_PLUGIN_STRING}
 * characters, as a standalone copy ({@link detach}).
 * @param s - String taken from a plugin file.
 * @returns Its first {@link MAX_PLUGIN_STRING} characters, detached.
 */
export function capPluginString(s: string): string {
  return detach(s.slice(0, MAX_PLUGIN_STRING));
}

/** True when the head looks binary: a NUL byte or the PDF magic. */
function looksBinary(head: Buffer): boolean {
  const sniff = head.subarray(0, SNIFF_BYTES);
  return sniff.includes(0) || sniff.toString("latin1").includes(PDF_MAGIC);
}

/** Decode a prefix as UTF-8 (dropping a trailing partial multi-byte sequence), cut at the last newline. */
function decodeCompleteLines(buf: Buffer): string {
  // ignoreBOM keeps a leading U+FEFF, exactly like readFileSync(..., "utf-8") does for small files.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf, { stream: true });
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? "" : text.slice(0, cut);
}

/**
 * Text to derive a description from. Regular files up to `maxFull` bytes are
 * read whole (same text as the historical `readFileSync`, via {@link readBoundedFd}); larger
 * ones contribute their first `maxFull` bytes cut at the last complete line
 * (`truncated: true`), and binary-looking ones nothing. Non-regular files
 * (FIFO, socket, device) are never opened.
 * @param filePath - Absolute path to the file.
 * @param maxFull - Whole-file read cap in bytes (see {@link resolveCartoFullReadMaxBytes}).
 * @returns The text and whether it is a truncated prefix; empty text when unreadable, non-regular or binary.
 */
export function readDescription(
  filePath: string,
  maxFull: number = resolveCartoFullReadMaxBytes(),
): DescriptionSource {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return { text: "", truncated: false };
    const fd = openSync(filePath, "r");
    try {
      // Never trust stat's size: read at most maxFull+1 bytes; more than maxFull -> prefix path.
      const whole = st.size <= maxFull ? readBoundedFd(fd, maxFull) : undefined;
      if (whole !== undefined) return { text: whole, truncated: false };
      const buf = Buffer.alloc(maxFull);
      const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
      return { text: looksBinary(head) ? "" : decodeCompleteLines(head), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

/**
 * Whole text of a small regular file, for the merge step's existing index and
 * sidecar. Anything else (missing, device or symlink to one, FIFO, directory,
 * larger than the cap) is treated as absent: never read, never followed to a device.
 * @param filePath - Path to read.
 * @param maxFull - Size cap in bytes (see {@link resolveCartoFullReadMaxBytes}).
 * @returns The file text, or `undefined` when absent, non-regular, oversize or unreadable.
 */
export function readSmallRegularFile(
  filePath: string,
  maxFull: number = resolveCartoFullReadMaxBytes(),
): string | undefined {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > maxFull) return undefined;
    const fd = openSync(filePath, "r");
    try {
      return readBoundedFd(fd, maxFull);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Read an open file to its end, but never more than `maxFull` bytes, whatever
 * `stat` claimed (Linux `/proc` files report size 0 yet stream).
 * @param fd - Open file descriptor.
 * @param maxFull - Byte cap.
 * @returns The UTF-8 text, or `undefined` when the file holds more than `maxFull` bytes.
 */
export function readBoundedFd(fd: number, maxFull: number): string | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(Math.min(64 * 1024, maxFull + 1 - total));
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > maxFull) return undefined;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

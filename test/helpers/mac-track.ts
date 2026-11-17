/** Helpers for the receipt MAC-binding / chain tests: build sessions, mount attacks, read the gate-level verdict. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrack, withTrack } from "../../src/tracking/store";
import { freshReceiptFromFile, recordReceipt, type Receipt } from "../../src/tracking/receipts";
import { journalLogPath } from "../../src/tracking/track-compact";

/** Fixed clock: receipts are fresh relative to it. */
export const T = 1_000_000_000_000;
/** Freshness window the gate would use. */
export const WINDOW = 600_000;

/** One session's track files (`track-<sid>.json|log|head` in its own temp dir). */
export interface Sess { dir: string; file: string; log: string; head: string; sid: string }

/** Fresh session in its own directory (key comes from the process HOME — run tests with an isolated HOME). */
export function sess(sid: string, dir: string = mkdtempSync(join(tmpdir(), "fh-mac-"))): Sess {
  const file = join(dir, `track-${sid}.json`);
  return { dir, file, log: journalLogPath(file), head: join(dir, `track-${sid}.head`), sid };
}

/** A passing test receipt at `ts`. */
export const pass = (ts: number): Receipt => ({ kind: "test", tool: "bun test", exitCode: 0, pass: 5, fail: 0, ts });
/** A failing test receipt at `ts`. */
export const fail = (ts: number): Receipt => ({ kind: "test", tool: "bun test", exitCode: 1, pass: 1, fail: 2, ts });

/** Append a receipt through the real write path. */
export const put = (s: Sess, r: Receipt): Promise<boolean> => withTrack(s.file, (t) => recordReceipt(t, r));
/** Append a read-reference event through the real write path. */
export const putRef = (s: Sess, p: string): Promise<boolean> => withTrack(s.file, (t) => ({ ...t, refsRead: [...t.refsRead, p], refsReadAt: { ...(t.refsReadAt ?? {}), [p]: T } }));

/** The gate-level verdict of a session: is there a fresh passing receipt, and did integrity fail (with its reason)? */
export async function verdict(s: Sess): Promise<{ receipt: boolean; failure: string | undefined; refs: string[] }> {
  const track = await loadTrack(s.file);
  return { receipt: freshReceiptFromFile(s.file, WINDOW, T) !== null, failure: track.integrityFailure, refs: track.refsRead };
}

/** Raw journal lines of a session. */
export const lines = (s: Sess): string[] => readFileSync(s.log, "utf8").split("\n").filter(Boolean);
/** Overwrite the journal with `ls`. */
export const setLines = (s: Sess, ls: string[]): void => writeFileSync(s.log, ls.join("\n") + "\n", "utf8");

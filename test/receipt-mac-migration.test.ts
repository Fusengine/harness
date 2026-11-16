/**
 * Migration of live sessions: a track written by the PRE-chain code (v1 lines,
 * unchained envelope snapshot) must keep reading exactly as before, accept new
 * chained appends (the first one seals the legacy prefix), survive compaction,
 * and never be modified by a read. Run with an isolated HOME.
 */
import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMac, loadOrCreateKey, signTrack } from "../src/tracking/integrity";
import { emptyTrack } from "../src/tracking/session-state";
import { loadTrack } from "../src/tracking/store";
import { maybeCompactJournal } from "../src/tracking/track-compact";
import { verifyJournal } from "../src/tracking/track-verify";
import { lines, pass, put, putRef, sess, setLines, T, verdict, type Sess } from "./helpers/mac-track";

/** A line exactly as the pre-chain code wrote it (v1: MAC over {field,op,value,ts}, no session/position binding). */
function legacyLine(field: string, op: string, value: unknown, ts: number): string {
  const nonce = randomBytes(8).toString("hex");
  return JSON.stringify({ v: 1, field, op, value, ts, nonce, mac: computeMac(loadOrCreateKey(), JSON.stringify({ field, op, value, ts }), nonce) });
}
const legacyLog = (s: Sess, n = 3): void => {
  const ls = Array.from({ length: n }, (_, i) => legacyLine("refsRead", "add", `/old-${i}.md`, T - 5000 + i));
  ls.push(legacyLine("receipts", "append", pass(T - 1000), T - 1000));
  writeFileSync(s.log, ls.join("\n") + "\n", "utf8");
};
const snapshotOf = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), "utf8")]));
const compact = async (file: string): Promise<void> => {
  process.env.FUSE_TRACK_COMPACT_BYTES = "1";
  try { await maybeCompactJournal(file); } finally { delete process.env.FUSE_TRACK_COMPACT_BYTES; }
};

test("legacy log: reads as before (receipt fresh, no failure, marked legacy) and the read writes NOTHING", async () => {
  const s = sess("legacy1");
  legacyLog(s);
  const before = snapshotOf(s.dir);
  const v = await verdict(s);
  expect(v).toEqual({ receipt: true, failure: undefined, refs: ["/old-0.md", "/old-1.md", "/old-2.md"] });
  expect(verifyJournal(s.file).report).toMatchObject({ ok: true, legacy: true });
  expect(snapshotOf(s.dir)).toEqual(before); // verifier is read-only (no head, no key, no snapshot created)
});

test("legacy snapshot (envelope, no chain head) + legacy tail: reads as before", async () => {
  const s = sess("legacy2");
  writeFileSync(s.file, JSON.stringify(signTrack({ ...emptyTrack(), refsRead: ["/snap.md"] })), "utf8");
  writeFileSync(s.log, legacyLine("refsRead", "add", "/tail.md", T) + "\n", "utf8");
  expect((await loadTrack(s.file)).refsRead.sort()).toEqual(["/snap.md", "/tail.md"]);
  expect(verifyJournal(s.file).report).toMatchObject({ ok: true, legacy: true });
});

test("upgrade mid-session: new code appends to a legacy log, the first chained line SEALS the legacy prefix", async () => {
  const s = sess("legacy3");
  legacyLog(s);
  expect(await putRef(s, "/new.md")).toBe(true);
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.refs).toEqual(["/old-0.md", "/old-1.md", "/old-2.md", "/new.md"]);
  expect(v.receipt).toBe(true); // the legacy receipt still counts
  expect(JSON.parse(lines(s)[4]!)).toMatchObject({ v: 2, seq: 1 }); // line 4 = first chained (after the 4 legacy lines)
  // sealed: deleting / reordering / adding legacy lines now breaks the chain
  setLines(s, lines(s).filter((_, i) => i !== 1));
  expect((await verdict(s)).failure).toBe("broken-chain");
});

test("a legacy (v1) line injected AFTER the chain started is refused", async () => {
  const s = sess("legacy4");
  legacyLog(s);
  await putRef(s, "/new.md");
  appendFileSync(s.log, legacyLine("refsRead", "add", "/evil.md", T) + "\n");
  const v = await verdict(s);
  expect(v.failure).toBe("legacy-after-chain");
  expect(v.refs).toEqual([]); // fail closed: empty track, not the stale prefix
});

test("migration end-to-end: legacy → new append → compaction → append → compaction: state identical, chain intact", async () => {
  const s = sess("legacy5");
  legacyLog(s);
  await putRef(s, "/n1.md");
  const before = await loadTrack(s.file);
  await compact(s.file); // folds legacy + chained, snapshot carries the chain head
  expect(await loadTrack(s.file)).toEqual(before);
  expect(JSON.parse(readFileSync(s.file, "utf8"))).toHaveProperty("mac"); // still a signed envelope
  await put(s, pass(T - 100));
  await putRef(s, "/n2.md");
  await compact(s.file);
  const after = await verdict(s);
  expect(after.failure).toBeUndefined();
  expect(after.refs).toEqual(["/old-0.md", "/old-1.md", "/old-2.md", "/n1.md", "/n2.md"]);
  expect(after.receipt).toBe(true);
});

test("legacy-only log compacted by new code, then appended: chain starts from the legacy digest", async () => {
  const s = sess("legacy6");
  legacyLog(s);
  await compact(s.file); // no chained line existed: head = digest of the legacy prefix
  expect((await verdict(s)).failure).toBeUndefined();
  await putRef(s, "/after.md");
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.refs).toContain("/after.md");
});

test("a legacy log holding a REPEATED v1 line (old readers counted it once) seals and verifies after a new append", async () => {
  const s = sess("legacy7");
  const l = legacyLine("receipts", "append", pass(T - 1000), T - 1000);
  writeFileSync(s.log, `${l}\n${l}\n`, "utf8");
  await putRef(s, "/n.md");
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.receipt).toBe(true);
  expect((await loadTrack(s.file)).receipts).toHaveLength(1);
});

test("crashed compaction on a legacy track (log renamed to .folding, never folded): new writes seal it, the recovery compaction keeps everything", async () => {
  const s = sess("legacy10");
  legacyLog(s);
  renameSync(s.log, `${s.log}.folding`); // killed between the rename and the fold (old or new code)
  expect((await verdict(s)).receipt).toBe(true); // the capture stays visible
  await putRef(s, "/n.md");
  expect((await verdict(s)).failure).toBeUndefined();
  await compact(s.file); // recovery folds the capture first, then the live log
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.receipt).toBe(true);
  expect(v.refs).toEqual(["/old-0.md", "/old-1.md", "/old-2.md", "/n.md"]);
  await putRef(s, "/n2.md");
  expect((await verdict(s)).failure).toBeUndefined();
});

test("a legacy snapshot + new append: the snapshot is part of the seal (replacing it afterwards is refused)", async () => {
  const s = sess("legacy11");
  const mk = (ref: string) => JSON.stringify(signTrack({ ...emptyTrack(), refsRead: [ref] }));
  writeFileSync(s.file, mk("/snap.md"), "utf8");
  await putRef(s, "/n.md");
  expect((await verdict(s)).failure).toBeUndefined();
  writeFileSync(s.file, mk("/forged-snap.md"), "utf8"); // another valid-looking old-format envelope
  expect((await verdict(s)).failure).toBe("broken-chain");
});

test("a v1 spill pending at upgrade time is sealed with the legacy prefix: still counted, absorbed by compaction; a v1 spill added AFTER sealing is refused", async () => {
  const s = sess("legacy8"), foreign = sess("legacy8f");
  writeFileSync(s.log, legacyLine("refsRead", "add", "/old.md", T - 5000) + "\n", "utf8");
  writeFileSync(`${s.log}.spill.${T}-1-aaaaaa`, legacyLine("receipts", "append", pass(T - 900), T - 900) + "\n", "utf8"); // an old-binary spill
  await putRef(s, "/n.md"); // seals log + pending spill
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.receipt).toBe(true);
  await compact(s.file);
  const after = await verdict(s);
  expect(after).toEqual(v);
  expect(readdirSync(s.dir).some((n) => n.includes(".spill."))).toBe(false);
  // replay: a genuine v1 receipt from ANOTHER session dropped in as a spill of the now-sealed session
  writeFileSync(foreign.log, legacyLine("receipts", "append", pass(T - 800), T - 800) + "\n", "utf8");
  writeFileSync(`${s.log}.spill.${T + 5}-2-bbbbbb`, lines(foreign)[0]! + "\n", "utf8");
  expect((await verdict(s)).receipt).toBe(true); // still the legitimately folded one…
  expect((await loadTrack(s.file)).receipts).toHaveLength(1); // …and the replayed one never counts
});

test("replayed v1 line spilled into a CHAINED session (before compaction) is an explicit failure", async () => {
  const s = sess("legacy9"), a = sess("legacy9a");
  await putRef(s, "/n.md");
  writeFileSync(a.log, legacyLine("receipts", "append", pass(T - 800), T - 800) + "\n", "utf8");
  writeFileSync(`${s.log}.spill.${T}-3-cccccc`, lines(a)[0]! + "\n", "utf8");
  const v = await verdict(s);
  expect(v.failure).toBe("broken-chain");
  expect(v.receipt).toBe(false);
});

test("an OLD binary appending a v1 line into an upgraded chained log is an EXPLICIT failure (documented strict choice), never silent", async () => {
  const s = sess("mixed");
  await putRef(s, "/new.md");
  appendFileSync(s.log, legacyLine("refsRead", "add", "/from-old-binary.md", T) + "\n"); // what a pre-chain hook process would do
  expect((await verdict(s)).failure).toBe("legacy-after-chain");
});

/** Chain continuity across compaction and spills (lock-free overflow). Run with an isolated HOME. */
import { test, expect } from "bun:test";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { signTrack } from "../src/tracking/integrity";
import { emptyTrack } from "../src/tracking/session-state";
import { loadTrack } from "../src/tracking/store";
import { maybeCompactJournal } from "../src/tracking/track-compact";
import { signEvent } from "../src/tracking/track-journal";
import { spillEvent } from "../src/tracking/track-spill";
import { fail, pass, put, putRef, sess, T, verdict } from "./helpers/mac-track";

const compact = async (file: string): Promise<void> => {
  process.env.FUSE_TRACK_COMPACT_BYTES = "1";
  try { await maybeCompactJournal(file); } finally { delete process.env.FUSE_TRACK_COMPACT_BYTES; }
};

test("spills: an own-session spill counts, a spill bound to another session is ignored; compaction keeps the chain", async () => {
  const s = sess("spill");
  await putRef(s, "/a.md");
  spillEvent(s.log, signEvent("receipts", "append", pass(T - 900), T - 900, "track-spill")!);
  spillEvent(s.log, signEvent("receipts", "append", pass(T - 800), T - 800, "track-spillother")!); // a replayed foreign spill
  expect((await verdict(s)).receipt).toBe(true);
  expect((await loadTrack(s.file)).receipts).toHaveLength(1);
  await compact(s.file);
  await putRef(s, "/b.md"); // the chain continues past the absorbing compaction
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.refs).toEqual(["/a.md", "/b.md"]);
  expect((await loadTrack(s.file)).receipts).toHaveLength(1); // absorbed exactly once
});

test("compaction keeps chaining: append → compact (x3) → append verifies; the head file tracks the last line", async () => {
  const s = sess("chainc");
  for (let round = 0; round < 3; round++) {
    await putRef(s, `/r${round}.md`);
    await compact(s.file);
  }
  await putRef(s, "/tail.md");
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.refs).toEqual(["/r0.md", "/r1.md", "/r2.md", "/tail.md"]);
  expect(JSON.parse(readFileSync(s.head, "utf8")).seq).toBe(8); // 4 × (refsRead + refsReadAt)
});

test("a snapshot copied from ANOTHER session (chain head bound to its sid) is refused, never adopted", async () => {
  const a = sess("snapA"), b = sess("snapB");
  await put(a, pass(T - 1000));
  await compact(a.file); // A: signed snapshot with a session-bound chain head
  await put(b, fail(T - 500)); // B: chained, uncompacted, only a failing receipt
  copyFileSync(a.file, b.file); // cp track-A.json track-B.json
  const v = await verdict(b);
  expect(v.failure).toBe("foreign-session");
  expect(v.receipt).toBe(false);
});

test("a legacy (chain-head-less) snapshot planted into an active chained session breaks the seal", async () => {
  const b = sess("snapC"), donor = sess("snapD");
  await putRef(b, "/b.md"); // chained from genesis (no snapshot at sealing time)
  writeFileSync(donor.file, JSON.stringify(signTrack({ ...emptyTrack(), receipts: [pass(T - 900)] })), "utf8"); // a genuine old-format envelope
  copyFileSync(donor.file, b.file);
  const v = await verdict(b);
  expect(v.failure).toBe("broken-chain");
  expect(v.receipt).toBe(false);
});

test("a crash-truncated last line (no trailing newline) does not swallow the next append nor fail the chain", async () => {
  const s = sess("trunc");
  await putRef(s, "/a.md");
  const { appendFileSync } = await import("node:fs");
  appendFileSync(s.log, '{"v":2,"field":"refsRead","op":"add","valu'); // power cut mid-write: junk, never a chained line
  await putRef(s, "/b.md");
  const v = await verdict(s);
  expect(v.failure).toBeUndefined();
  expect(v.refs).toEqual(["/a.md", "/b.md"]);
});

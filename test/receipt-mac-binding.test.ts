/**
 * One RED→GREEN test per receipt-journal attack (the MAC binds session id +
 * monotonic seq + previous MAC; a MAC-protected head records the last line).
 * Each attack must surface as an EXPLICIT failure (`integrityFailure` reason)
 * and the receipt gate must read "no proof" — never a silently older/empty
 * valid track. Run with an isolated HOME: `HOME=$(mktemp -d) bun test …`.
 */
import { test, expect } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { maybeCompactJournal } from "../src/tracking/track-compact";
import { fail, lines, pass, put, putRef, sess, setLines, T, verdict } from "./helpers/mac-track";
import { STORE } from "./helpers/track-env";

const compact = async (file: string): Promise<void> => {
  process.env.FUSE_TRACK_COMPACT_BYTES = "1";
  try { await maybeCompactJournal(file); } finally { delete process.env.FUSE_TRACK_COMPACT_BYTES; }
};

test("valid track: receipt visible, no failure (control)", async () => {
  const s = sess("ctl");
  await putRef(s, "/a.md");
  await put(s, pass(T - 1000));
  expect(await verdict(s)).toEqual({ receipt: true, failure: undefined, refs: ["/a.md"] });
});

test("cross-session replay: a valid passing-receipt line copied from session A into session B is refused", async () => {
  const a = sess("A"), b = sess("B");
  await put(a, pass(T - 1000));
  await putRef(b, "/b.md");
  setLines(b, [...lines(b), lines(a)[0]!]); // the attacker replays A's genuine, correctly-MAC'd line
  const v = await verdict(b);
  expect(v.failure).toBe("foreign-session");
  expect(v.receipt).toBe(false);
});

test("cross-session replay of a WHOLE journal (copy A's log over B's) is refused", async () => {
  const a = sess("A2"), b = sess("B2");
  await put(a, pass(T - 1000));
  await putRef(b, "/b.md");
  copyFileSync(a.log, b.log);
  expect((await verdict(b)).failure).toBe("foreign-session");
});

test("replay of a line inside its own session (duplicate) is refused", async () => {
  const s = sess("dup");
  await put(s, pass(T - 1000));
  await putRef(s, "/x.md");
  setLines(s, [...lines(s), lines(s)[0]!]);
  expect((await verdict(s)).failure).toBe("duplicate-or-reorder");
});

test("reordering lines within a session is refused", async () => {
  const s = sess("reord");
  await putRef(s, "/1.md");
  await putRef(s, "/2.md");
  await put(s, pass(T - 1000));
  const [l1, l2, l3] = lines(s);
  setLines(s, [l1!, l3!, l2!]);
  const v = await verdict(s);
  expect(v.failure).toBe("gap");
  expect(v.receipt).toBe(false);
});

test("rollback: restoring an older valid copy of the log is detected (head is ahead)", async () => {
  const s = sess("roll");
  await put(s, pass(T - 2000));
  const older = readFileSync(s.log, "utf8"); // the attacker's saved copy
  await put(s, fail(T - 500)); // later evidence the attacker wants gone
  writeFileSync(s.log, older, "utf8");
  const v = await verdict(s);
  expect(v.failure).toBe("truncated");
  expect(v.receipt).toBe(false);
});

test("rollback: restoring an older snapshot after a newer compaction is detected", async () => {
  const s = sess("rollsnap");
  await put(s, pass(T - 3000));
  await compact(s.file);
  const olderSnap = readFileSync(s.file, "utf8");
  await put(s, fail(T - 500));
  await compact(s.file);
  writeFileSync(s.file, olderSnap, "utf8"); // valid, correctly signed — but old
  const v = await verdict(s);
  expect(v.failure).toBe("truncated");
  expect(v.receipt).toBe(false);
});

test("deleting the LAST line is detected", async () => {
  const s = sess("dellast");
  await put(s, pass(T - 2000));
  await put(s, fail(T - 500));
  setLines(s, lines(s).slice(0, -1));
  const v = await verdict(s);
  expect(v.failure).toBe("truncated");
  expect(v.receipt).toBe(false);
});

test("deleting a MIDDLE line is detected", async () => {
  const s = sess("delmid");
  await putRef(s, "/1.md");
  await put(s, fail(T - 700));
  await put(s, pass(T - 500));
  setLines(s, lines(s).filter((_, i) => i !== 1));
  const v = await verdict(s);
  expect(v.failure).toBe("gap");
  expect(v.receipt).toBe(false);
});

test("editing a line is detected (bad MAC), never partially trusted", async () => {
  const s = sess("edit");
  await put(s, fail(T - 500));
  const l = JSON.parse(lines(s)[0]!) as { value: { exitCode: number; fail: number } };
  l.value.exitCode = 0; l.value.fail = 0; // turn the failing run into a pass
  setLines(s, [JSON.stringify(l)]);
  const v = await verdict(s);
  expect(v.failure).toBe("bad-mac");
  expect(v.receipt).toBe(false);
});

test("deleting the whole journal (and snapshot) is 'missing', never an empty valid track", async () => {
  const s = sess("delall");
  await put(s, pass(T - 1000));
  unlinkSync(s.log);
  const v = await verdict(s);
  expect(v.failure).toBe("missing");
  expect(v.receipt).toBe(false);
  const c = sess("delall2");
  await put(c, pass(T - 1000));
  await compact(c.file);
  unlinkSync(c.file); // snapshot gone, log already folded away
  expect((await verdict(c)).failure).toBe("missing");
});

test("head file: forged or deleted while a chain exists is an explicit failure", async () => {
  const s = sess("head");
  await put(s, pass(T - 1000));
  const good = readFileSync(s.head, "utf8");
  writeFileSync(s.head, good.replace(/"seq":\d+/, '"seq":99'), "utf8");
  expect((await verdict(s)).failure).toBe("head-invalid");
  unlinkSync(s.head);
  expect((await verdict(s)).failure).toBe("head-missing");
});

test("fresh HOME verifier: a track copied to a HOME with no key fails 'key-missing' and creates NO key", () => {
  const s = sess("fresh");
  const probe = (home: string, file: string) => spawnSync("bun", ["-e", `import { loadTrack } from ${JSON.stringify(STORE)};
const t = await loadTrack(${JSON.stringify(file)});
process.stdout.write(JSON.stringify({ failure: t.integrityFailure ?? null, receipts: (t.receipts ?? []).length }));`], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  const writer = mkdtempSync(join(tmpdir(), "fh-home-w-"));
  const w = spawnSync("bun", ["-e", `import { withTrack } from ${JSON.stringify(STORE)};
await withTrack(${JSON.stringify(s.file)}, (t) => ({ ...t, receipts: [{ kind: "test", tool: "bun test", exitCode: 0, pass: 1, fail: 0, ts: ${T} }] }));`], { env: { ...process.env, HOME: writer }, encoding: "utf8" });
  expect(w.status).toBe(0);
  const copy = mkdtempSync(join(tmpdir(), "fh-copy-"));
  cpSync(s.dir, copy, { recursive: true });
  const fresh = mkdtempSync(join(tmpdir(), "fh-home-v-"));
  const r = probe(fresh, join(copy, "track-fresh.json"));
  expect(JSON.parse(r.stdout)).toEqual({ failure: "key-missing", receipts: 0 });
  expect(existsSync(join(fresh, ".fuse-harness", ".key"))).toBe(false); // the verifier never mints a key
  const ok = probe(writer, join(copy, "track-fresh.json")); // same key: verifies
  expect(JSON.parse(ok.stdout)).toEqual({ failure: null, receipts: 1 });
});

test("fresh HOME, nothing on disk (first use): empty valid track, still no key created", () => {
  const fresh = mkdtempSync(join(tmpdir(), "fh-home-n-")), d = mkdtempSync(join(tmpdir(), "fh-none-"));
  const r = spawnSync("bun", ["-e", `import { loadTrack } from ${JSON.stringify(STORE)};
const t = await loadTrack(${JSON.stringify(join(d, "track-none.json"))});
process.stdout.write(JSON.stringify({ failure: t.integrityFailure ?? null, refs: t.refsRead.length }));`], { env: { ...process.env, HOME: fresh }, encoding: "utf8" });
  expect(JSON.parse(r.stdout)).toEqual({ failure: null, refs: 0 });
  expect(existsSync(join(fresh, ".fuse-harness", ".key"))).toBe(false);
});

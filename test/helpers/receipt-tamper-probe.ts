/**
 * Probe run in a SUBPROCESS with an isolated HOME (Bun caches `os.homedir()`): replays the data-layer tamper
 * attempts an agent with file access could make against the signed track journal / snapshot and prints, per
 * attempt, whether a forged or altered receipt is still ACCEPTED by `freshReceiptFromFile` (the TaskCompleted gate's read).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMac, loadOrCreateKey, signTrack } from "../../src/tracking/integrity";
import { freshReceiptFromFile } from "../../src/tracking/receipts";
import { journalLogPath, parseEvents } from "../../src/tracking/track-compact";
import { appendEvent, signEvent, type TrackEvent } from "../../src/tracking/track-journal";
import { emptyTrack } from "../../src/tracking/session-state";
import type { Receipt } from "../../src/tracking/receipts";

const NOW = 1_000_000;
const WINDOW = 60_000;
const root = process.env.PROBE_DIR as string;
mkdirSync(root, { recursive: true });

// Mode "export": write one honest session (snapshot + journal) and print its path — the artefacts a CI would be handed.
// Mode "verify": CI side — fresh HOME, only the exported files; print what the gate-read accepts and whether a key now exists.
if (process.env.PROBE_MODE === "export") {
  const file = join(root, "track-export.json");
  appendEvent(journalLogPath(file), "receipts", "append", { kind: "test", tool: "bun test", exitCode: 0, pass: 9, fail: 0, ts: NOW - 1000 }, NOW - 1000);
  process.stdout.write(JSON.stringify({ file }));
  process.exit(0);
}
if (process.env.PROBE_MODE === "verify") {
  const file = process.env.PROBE_FILE as string;
  const keyFile = join(process.env.HOME as string, ".fuse-harness", ".key");
  const keyBefore = existsSync(keyFile);
  const events = parseEvents(readFileSync(journalLogPath(file), "utf8")).length;
  process.stdout.write(JSON.stringify({ keyBefore, events, accepted: freshReceiptFromFile(file, WINDOW, NOW) !== null, keyMintedByVerifier: !keyBefore && existsSync(keyFile) }));
  process.exit(0);
}
const out: Record<string, unknown> = {};
let n = 0;

/** A passing `bun test` receipt stamped at `ts`. */
const pass = (ts: number): Receipt => ({ kind: "test", tool: "bun test", exitCode: 0, pass: 9, fail: 0, ts });
/** A failing `bun test` receipt stamped at `ts`. */
const fail = (ts: number): Receipt => ({ kind: "test", tool: "bun test", exitCode: 1, pass: 0, fail: 3, ts });
/** A fresh session track path (`track-sN.json`) with its journal twin. */
const session = (): { file: string; log: string } => { const file = join(root, `track-s${n++}.json`); return { file, log: journalLogPath(file) }; };
/** Whether the TaskCompleted gate-read accepts a fresh receipt from `file`. */
const accepted = (file: string): boolean => freshReceiptFromFile(file, WINDOW, NOW) !== null;
/** Non-empty lines of a journal file. */
const lines = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
/** A receipt-append event signed with the machine key. */
const sign = (r: Receipt): TrackEvent => signEvent("receipts", "append", r, r.ts) as TrackEvent;

// s0 control: an honestly appended passing receipt is accepted.
{ const s = session(); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000); out.control_honest = accepted(s.file); }
// s1 edit: a signed FAILING receipt is rewritten to exit 0 / pass 9 without re-signing.
{ const s = session(); appendEvent(s.log, "receipts", "append", fail(NOW - 1000), NOW - 1000);
  const edited = lines(s.log)[0]!.replace('"exitCode":1', '"exitCode":0').replace('"pass":0', '"pass":9').replace('"fail":3', '"fail":0');
  writeFileSync(s.log, edited + "\n"); out.edit_line_without_resign = accepted(s.file); }
// s2 forge unsigned / bad mac.
{ const s = session(); const ev = { ...sign(pass(NOW - 1000)), mac: "0".repeat(64) }; appendFileSync(s.log, JSON.stringify(ev) + "\n"); out.forge_bad_mac = accepted(s.file); }
// s3 forge with a guessed key.
{ const s = session(); const ev = sign(pass(NOW - 1000)); const data = JSON.stringify({ field: ev.field, op: ev.op, value: ev.value, ts: ev.ts });
  appendFileSync(s.log, JSON.stringify({ ...ev, mac: computeMac("attacker-guess", data, ev.nonce) }) + "\n"); out.forge_wrong_key = accepted(s.file); }
// s4 forge with the machine key READ from <HOME>/.fuse-harness/.key (what an agent with file read can do).
{ const s = session(); const key = readFileSync(join(process.env.HOME as string, ".fuse-harness", ".key"), "utf8").trim();
  const value = pass(NOW - 1000); const data = JSON.stringify({ field: "receipts", op: "append", value, ts: value.ts });
  const ev = { v: 1, field: "receipts", op: "append", value, ts: value.ts, nonce: "deadbeefdeadbeef", mac: computeMac(key, data, "deadbeefdeadbeef") };
  appendFileSync(s.log, JSON.stringify(ev) + "\n"); out.forge_with_read_key = accepted(s.file);
  out.key_mode_octal = (statSync(join(process.env.HOME as string, ".fuse-harness", ".key")).mode & 0o777).toString(8); }
// s5 replay: a valid line copied from session A into session B (the MAC binds no session id), then the same line aged out of the window.
{ const a = session(), b = session(); appendEvent(a.log, "receipts", "append", pass(NOW - 1000), NOW - 1000);
  appendFileSync(b.log, lines(a.log)[0] + "\n"); out.replay_into_other_session = accepted(b.file);
  const c = session(), d = session(); appendEvent(c.log, "receipts", "append", pass(NOW - WINDOW - 5000), NOW - WINDOW - 5000);
  appendFileSync(d.log, lines(c.log)[0] + "\n"); out.replay_stale_line = accepted(d.file); }
// s5b replay edit of ts to make a stale line fresh: breaks the MAC.
{ const s = session(); appendEvent(s.log, "receipts", "append", pass(NOW - WINDOW - 5000), NOW - WINDOW - 5000);
  const l = JSON.parse(lines(s.log)[0]!) as TrackEvent; l.ts = NOW - 1000; (l.value as Receipt).ts = NOW - 1000; writeFileSync(s.log, JSON.stringify(l) + "\n"); out.restamp_stale_line = accepted(s.file); }
// s6 truncate / delete lines: deleting a signed FAILING receipt or a violation record is not detected.
{ const s = session(); appendEvent(s.log, "receipts", "append", fail(NOW - 500), NOW - 500); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000);
  const before = parseEvents(readFileSync(s.log, "utf8")).length; writeFileSync(s.log, lines(s.log).slice(1).join("\n") + "\n");
  out.truncate_drops_failing_line = { eventsBefore: before, eventsAfter: parseEvents(readFileSync(s.log, "utf8")).length, detected: false }; }
{ const s = session(); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000); writeFileSync(s.log, ""); out.truncate_to_empty_receipt_survives = accepted(s.file); }
// s7 reorder lines: the fold sorts by ts, so order is irrelevant (no sequence number / hash chain either).
{ const s = session(); appendEvent(s.log, "receipts", "append", fail(NOW - 500), NOW - 500); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000);
  const before = accepted(s.file); writeFileSync(s.log, lines(s.log).reverse().join("\n") + "\n"); out.reorder_changes_verdict = before !== accepted(s.file); }
// s8 duplicate the same line N times: deduped by nonce.
{ const s = session(); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000); const l = lines(s.log)[0]!; appendFileSync(s.log, `${l}\n${l}\n`);
  const t = freshReceiptFromFile(s.file, WINDOW, NOW); out.duplicate_lines_counted_once = t !== null && new Set(parseEvents(readFileSync(s.log, "utf8")).map((e) => e.nonce)).size === 1; }
// s9 snapshot: edit data without re-signing; delete; roll back to an older valid snapshot.
{ const s = session(); writeFileSync(s.file, JSON.stringify(signTrack({ ...emptyTrack(), receipts: [fail(NOW - 1000)] })));
  const env = JSON.parse(readFileSync(s.file, "utf8")) as { data: string }; env.data = env.data.replace('"exitCode":1', '"exitCode":0').replace('"fail":3', '"fail":0').replace('"pass":0', '"pass":9');
  writeFileSync(s.file, JSON.stringify(env)); out.snapshot_edit_without_resign = accepted(s.file); }
{ const s = session(); writeFileSync(s.file, JSON.stringify(signTrack({ ...emptyTrack(), receipts: [pass(NOW - 1000)] }))); copyFileSync(s.file, `${s.file}.bak`);
  writeFileSync(s.file, JSON.stringify(signTrack({ ...emptyTrack(), receipts: [fail(NOW - 500)] }))); copyFileSync(`${s.file}.bak`, s.file); out.snapshot_rollback_to_older_valid = accepted(s.file);
  out.snapshot_delete_loses_receipts = (() => { writeFileSync(s.file, "garbage"); return accepted(s.file); })(); }
// s10 key replacement: swapping the key invalidates every previous line; the attacker then signs freely with its own key.
{ const s = session(); appendEvent(s.log, "receipts", "append", pass(NOW - 1000), NOW - 1000);
  const keyFile = join(process.env.HOME as string, ".fuse-harness", ".key"); const original = readFileSync(keyFile, "utf8");
  writeFileSync(keyFile, "attacker-chosen-key"); out.after_key_swap_old_lines_valid = accepted(s.file);
  const value = pass(NOW - 1000); const data = JSON.stringify({ field: "receipts", op: "append", value, ts: value.ts });
  appendFileSync(s.log, JSON.stringify({ v: 1, field: "receipts", op: "append", value, ts: value.ts, nonce: "0011223344556677", mac: computeMac(loadOrCreateKey(), data, "0011223344556677") }) + "\n");
  out.after_key_swap_attacker_line_valid = accepted(s.file); writeFileSync(keyFile, original); }
out.key_file_exists = existsSync(join(process.env.HOME as string, ".fuse-harness", ".key"));
process.stdout.write(JSON.stringify(out));

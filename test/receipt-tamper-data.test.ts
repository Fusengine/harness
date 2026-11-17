/**
 * Data-layer tamper attempts on the HMAC-signed track journal / snapshot (the store verification receipts live in).
 * Runs `helpers/receipt-tamper-probe.ts` in a subprocess with an isolated HOME and pins, per attempt, whether the
 * forged/altered receipt is still accepted by the TaskCompleted gate's read (`freshReceiptFromFile`).
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = join(import.meta.dir, "helpers", "receipt-tamper-probe.ts");

/** Run the probe in a subprocess with HOME isolated on its own command line (Bun caches `os.homedir()`). */
function probe2(home: string, extra: Record<string, string>): Record<string, unknown> {
  const r = Bun.spawnSync(["bun", probe], { env: { PATH: process.env.PATH ?? "", HOME: home, PROBE_DIR: join(home, "probe"), ...extra }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`probe failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
}

test("CI re-verification: exported artefacts alone verify nothing; only the session machine's secret key makes them verify", () => {
  const session = mkdtempSync(join(tmpdir(), "fh-rt-ci-session-"));
  const file = (probe2(session, { PROBE_MODE: "export" }) as { file: string }).file;
  // Fresh HOME, artefacts only (track-export.json + .log): every line fails the MAC under the verifier's own, freshly minted key.
  const ci = mkdtempSync(join(tmpdir(), "fh-rt-ci-fresh-"));
  expect(probe2(ci, { PROBE_MODE: "verify", PROBE_FILE: file })).toEqual({ keyBefore: false, events: 0, accepted: false, keyMintedByVerifier: true });
  // The same artefacts verify only once the SESSION's .key is copied over: HMAC is symmetric, so the verifier holds forging power too.
  const withKey = mkdtempSync(join(tmpdir(), "fh-rt-ci-key-"));
  mkdirSync(join(withKey, ".fuse-harness"), { recursive: true });
  copyFileSync(join(session, ".fuse-harness", ".key"), join(withKey, ".fuse-harness", ".key"));
  expect(probe2(withKey, { PROBE_MODE: "verify", PROBE_FILE: file })).toEqual({ keyBefore: true, events: 1, accepted: true, keyMintedByVerifier: false });
});

test("signed journal/snapshot: which tamper attempts are rejected, which are not", () => {
  const o = probe2(mkdtempSync(join(tmpdir(), "fh-rt-data-home-")), {});
  console.log(JSON.stringify(o, null, 2));
  // control
  expect(o.control_honest).toBe(true);
  // STOPPED by the per-line / snapshot MAC (integrity.ts computeMac, track-compact.ts:parseEvents "fail-closed per line", integrity.ts verifyTrack)
  expect(o.edit_line_without_resign).toBe(false);
  expect(o.forge_bad_mac).toBe(false);
  expect(o.forge_wrong_key).toBe(false);
  expect(o.restamp_stale_line).toBe(false);
  expect(o.snapshot_edit_without_resign).toBe(false);
  expect(o.snapshot_delete_loses_receipts).toBe(false);
  expect(o.after_key_swap_old_lines_valid).toBe(false);
  // STOPPED by the freshness window (receipts.ts freshPassingReceipt cutoff) and, since the 0.1.124 hash chain (track-chain/track-verify), by chain breaks
  expect(o.replay_stale_line).toBe(false);
  expect(o.duplicate_lines_counted_once).toBe(false); // a duplicated line breaks the chain: the whole receipt is rejected (was: deduped by nonce)
  expect(o.reorder_changes_verdict).toBe(true); // a reordered journal no longer verifies (was: order-independent)
  // NOT STOPPED: documented threat model (integrity.ts header: "the machine key is readable by the same agent process")
  expect(o.forge_with_read_key).toBe(true);
  expect(o.after_key_swap_attacker_line_valid).toBe(true);
  expect(o.key_mode_octal).toBe("600");
  // STOPPED since 0.1.124: the MAC binds the session id, a sequence number and the previous line's MAC (cross-session replay fails closed)
  expect(o.replay_into_other_session).toBe(false);
  // NOT re-measured by the probe (its `detected` field is a constant) and unchanged by the 0.1.124 fix:
  expect(o.snapshot_rollback_to_older_valid).toBe(true);
  expect(o.truncate_drops_failing_line).toEqual({ eventsBefore: 2, eventsAfter: 1, detected: false });
  expect(o.truncate_to_empty_receipt_survives).toBe(false); // deleting everything only ever loses proof (fail-closed for the receipt gate)
});

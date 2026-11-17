/**
 * Verdict differential guard: the Stop/TaskCompleted receipt gate answers the
 * SAME for a valid track whether it was written by the pre-chain code (v1
 * lines) or the chained writer, on every host id. Expected verdicts were
 * frozen from the pre-chain implementation (corpus run against origin/main).
 * Run with an isolated HOME.
 */
import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSessionState } from "../src/runtime/home-state";
import { validateTaskSolid } from "../src/runtime/lifecycle/task-completed";
import { computeMac, loadOrCreateKey } from "../src/tracking/integrity";
import { fail, lines, pass, put, sess, T, type Sess } from "./helpers/mac-track";
import type { Receipt } from "../src/tracking/receipts";

const HOSTS = ["claude-code", "codex", "cursor", "kimi", "gemini", "cline", "hermes"];
const ROWS: { name: string; receipts: Receipt[]; want: "PASS" | "REFUSE" }[] = [
  { name: "no receipt", receipts: [], want: "REFUSE" },
  { name: "fresh pass", receipts: [pass(T - 1000)], want: "PASS" },
  { name: "fail only", receipts: [fail(T - 1000)], want: "REFUSE" },
  { name: "stale pass", receipts: [pass(T - 10_000_000)], want: "REFUSE" },
  { name: "pass then newer fail (any fresh pass counts)", receipts: [pass(T - 3000), fail(T - 1000)], want: "PASS" },
];

/** Rewrite a chained journal as the pre-chain writer would have (v1: unbound MAC, no seq/prev). */
function asLegacy(s: Sess): void {
  const key = loadOrCreateKey();
  const out = lines(s).map((l) => {
    const e = JSON.parse(l) as { field: string; op: string; value: unknown; ts: number };
    const nonce = randomBytes(8).toString("hex");
    return JSON.stringify({ v: 1, field: e.field, op: e.op, value: e.value, ts: e.ts, nonce, mac: computeMac(key, JSON.stringify({ field: e.field, op: e.op, value: e.value, ts: e.ts }), nonce) });
  });
  writeFileSync(s.log, out.join("\n") + "\n");
  unlinkSync(s.head); // the pre-chain code never wrote a head file
}

const verdictOf = (s: Sess, host: string, code: string, home: string): string => {
  saveSessionState(s.sid, { changes: { modifiedFiles: [code], editedAt: { [code]: T - 5000 } } }, home);
  const out = validateTaskSolid({ session_id: s.sid, task_id: "t", task_subject: "s" }, home, T, s.dir, host === "claude-code" ? "TaskCompleted" : "Stop", host);
  return out === "" ? "PASS" : "REFUSE";
};

for (const row of ROWS) {
  test(`gate verdict unchanged (${row.name}) — new writer and legacy-format track, all host ids`, async () => {
    const code = join(mkdtempSync(join(tmpdir(), "fh-code-")), "ok.ts");
    writeFileSync(code, "export const x = 1;\n");
    for (const legacy of [false, true]) for (const host of HOSTS) {
      const s = sess(`gv-${legacy ? "old" : "new"}-${host}-${row.name.replace(/\W+/g, "")}`);
      for (const r of row.receipts) await put(s, r);
      if (legacy && row.receipts.length) asLegacy(s);
      // the Stop path keeps a once-per-session notice beside the track: one fresh sid per probe
      expect(verdictOf(s, host, code, mkdtempSync(join(tmpdir(), "fh-home-")))).toBe(row.want);
    }
  });
}

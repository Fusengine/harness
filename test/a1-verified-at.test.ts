import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveSessionState, loadSessionState } from "../src/runtime/home-state";
import { validateTaskSolid } from "../src/runtime/lifecycle/task-completed";
import { trackSessionChanges } from "../src/runtime/lifecycle/track-changes";
import { lastCodeEditAt } from "../src/runtime/lifecycle/code-edit-time";
import { isClaudeScratchpad } from "../src/runtime/lifecycle/scratchpad-path";
import { trackFile } from "../src/runtime/paths";
import { saveTrack } from "../src/tracking/store";
import { captureReceipt, recordReceipt } from "../src/tracking/receipts";
import { emptyTrack } from "../src/tracking/session-state";
import { loadTrack } from "../src/tracking/store";

const root = (): string => mkdtempSync(join(tmpdir(), "fh-a1-"));
const T = 1_000_000_000_000;

/** A small compliant code file, returned as its path. */
function codeFile(name = "ok.ts"): string {
  const p = join(root(), name);
  writeFileSync(p, "export const x = 1;\n");
  return p;
}

/** Seed session state + a passing receipt (`verifiedAt` = test start, `ts` = capture time). */
async function seed(sid: string, file: string, editedAt: number | undefined, receipt: { ts: number; verifiedAt?: number }, stateDir: string, home: string): Promise<void> {
  const changes = { modifiedFiles: [file], ...(editedAt !== undefined ? { editedAt: { [file]: editedAt } } : {}) };
  saveSessionState(sid, { changes }, home);
  await saveTrack(trackFile(sid, stateDir), recordReceipt(emptyTrack(), { kind: "test", tool: "bun test", exitCode: 0, pass: 3, fail: 0, ...receipt }));
}

const run = (sid: string, home: string, stateDir: string, now = T): string =>
  validateTaskSolid({ session_id: sid, task_id: "t", task_subject: "s" }, home, now, stateDir);

test("a1 verifiedAt: file edited AFTER the test started still blocks (edit during the run)", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  await seed("v1", f, T - 3000, { ts: T - 1000, verifiedAt: T - 5000 }, stateDir, home);
  const parsed = JSON.parse(run("v1", home, stateDir)) as { continue: boolean; stopReason: string };
  expect(parsed.continue).toBe(false);
  expect(parsed.stopReason).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 verifiedAt: file edited BEFORE the green run passes even past the TTL window, modifiedFiles is NOT cleared", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  const old = T - 60 * 60 * 1000; // far beyond TTL x5
  await seed("v2", f, old - 5000, { ts: old, verifiedAt: old - 1000 }, stateDir, home);
  expect(run("v2", home, stateDir)).toBe("");
  const changes = loadSessionState("v2", home).changes as { modifiedFiles: string[] };
  expect(changes.modifiedFiles).toEqual([f]);
});

test("a1 verifiedAt: a file edited after an old green run blocks again", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  const old = T - 60 * 60 * 1000;
  await seed("v3", f, T - 10, { ts: old, verifiedAt: old - 1000 }, stateDir, home);
  expect(run("v3", home, stateDir)).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 verifiedAt: legacy file without an edit stamp keeps the old TTL semantic (expired receipt blocks)", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  const old = T - 60 * 60 * 1000;
  await seed("v4", f, undefined, { ts: old }, stateDir, home);
  expect(run("v4", home, stateDir)).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 captureReceipt: durationMs stamps verifiedAt = now - duration; absent duration leaves the receipt shape unchanged", async () => {
  const file = trackFile("cap", root());
  await captureReceipt(file, "bun test", " 3 pass\n 0 fail\n", 0, T, 4000);
  await captureReceipt(file, "bun test", " 3 pass\n 0 fail\n", 0, T + 10);
  const [a, b] = (await loadTrack(file)).receipts ?? [];
  expect(a?.verifiedAt).toBe(T - 4000);
  expect(b?.verifiedAt).toBeUndefined();
  expect(b?.ts).toBe(T + 10);
});

test("a1 verifiedAt: receipt WITHOUT duration_ms behaves exactly as before (85fa53a): file edited during the run, receipt past TTL -> refused", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  const old = T - 60 * 60 * 1000;
  await seed("v5", f, old - 3000, { ts: old }, stateDir, home); // stamped before the receipt's ts, no verifiedAt
  expect(run("v5", home, stateDir)).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 verifiedAt: receipt WITHOUT duration_ms and still fresh passes as before (85fa53a)", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  await seed("v6", f, T - 3000, { ts: T - 1000 }, stateDir, home);
  expect(run("v6", home, stateDir)).toBe("");
});

const SP = "/private/tmp/claude-501/-Users-x-proj/0a1b2c3d-1111-4222-8333-444455556666/scratchpad/probe.ts";

test("a1 scratchpad: a real Claude Code scratchpad path yields empty from the receipt gate", () => {
  const home = root(); const stateDir = root();
  saveSessionState("sp1", { changes: { modifiedFiles: [SP] } }, home);
  expect(run("sp1", home, stateDir)).toBe("");
});

test("a1 scratchpad: only the real pattern is excluded (uid/slug/uuid/scratchpad); user dirs keep their gate", () => {
  expect(isClaudeScratchpad(SP)).toBe(true);
  expect(isClaudeScratchpad("/tmp/claude-1000/proj/0a1b2c3d-1111-4222-8333-444455556666/scratchpad/a.ts")).toBe(true);
  expect(isClaudeScratchpad("/home/u/claude-3/proj/src/scratchpad/a.ts")).toBe(false);
  expect(isClaudeScratchpad("/tmp/claude-3/scratchpad/a.ts")).toBe(false);
  expect(isClaudeScratchpad("/tmp/claude-1000/proj/not-a-uuid/scratchpad/a.ts")).toBe(false);
  expect(isClaudeScratchpad(join(tmpdir(), "fh-task-1", "ok.ts"))).toBe(false);
  expect(isClaudeScratchpad("/tmp/myproj/scratchpad/a.ts")).toBe(false);
});

test("a1 scratchpad: a project dir named claude-3/.../scratchpad keeps the receipt gate", () => {
  const home = root(); const stateDir = root();
  const dir = join(root(), "claude-3", "proj", "scratchpad");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "a.ts");
  writeFileSync(f, "export const x = 1;\n");
  saveSessionState("sp2", { changes: { modifiedFiles: [f] } }, home);
  expect(run("sp2", home, stateDir)).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 scratchpad: tracking is UNCHANGED (file still listed, sniper reminder still emitted) but never stamped", () => {
  const home = root();
  const out = trackSessionChanges("sp3", SP, home, T);
  expect(out).toContain("SNIPER VALIDATION REQUIRED");
  const ch = loadSessionState("sp3", home).changes as { modifiedFiles: string[]; editedAt: Record<string, number> };
  expect(ch.modifiedFiles).toEqual([SP]);
  expect(ch.editedAt[SP]).toBeUndefined();
});

/** Seed a file edit plus two passing receipts (older first) into the session state and track. */
async function seedTwo(sid: string, f: string, editedAt: number, a: { ts: number; verifiedAt?: number }, b: { ts: number; verifiedAt?: number }, stateDir: string, home: string): Promise<void> {
  saveSessionState(sid, { changes: { modifiedFiles: [f], editedAt: { [f]: editedAt } } }, home);
  const base = { kind: "test" as const, tool: "bun test", exitCode: 0, pass: 3, fail: 0 };
  await saveTrack(trackFile(sid, stateDir), recordReceipt(recordReceipt(emptyTrack(), { ...base, ...a }), { ...base, ...b }));
}

test("a1 verifiedAt: older receipt WITH verifiedAt, edit, then NEWER receipt WITHOUT duration_ms (fresh) -> allowed (85fa53a TTL rule)", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  await seedTwo("m1", f, T - 3000, { ts: T - 4000, verifiedAt: T - 5000 }, { ts: T - 1000 }, stateDir, home);
  expect(run("m1", home, stateDir)).toBe("");
});

test("a1 verifiedAt: newest receipt HAS verifiedAt and the file was edited after it -> still blocked", async () => {
  const home = root(); const stateDir = root(); const f = codeFile();
  await seedTwo("m2", f, T - 3000, { ts: T - 6000 }, { ts: T - 1000, verifiedAt: T - 5000 }, stateDir, home);
  expect(run("m2", home, stateDir)).toContain("VERIFICATION RECEIPT REQUIRED");
});

test("a1 trackSessionChanges: stamps editedAt, lastCodeEditAt reads it; scratchpad and version files do not move it", () => {
  const home = root();
  const real = join(root(), "src");
  mkdirSync(real, { recursive: true });
  const p = join(real, "a.ts");
  trackSessionChanges("se1", p, home, T);
  expect(lastCodeEditAt("se1", home)).toBe(T);
  trackSessionChanges("se1", p, home, T + 500);
  expect(lastCodeEditAt("se1", home)).toBe(T + 500);
  trackSessionChanges("se1", SP, home, T + 9000);
  trackSessionChanges("se1", join(real, "__version__.py"), home, T + 9000);
  expect(lastCodeEditAt("se1", home)).toBe(T + 500);
  expect(lastCodeEditAt("never", home)).toBe(0);
});

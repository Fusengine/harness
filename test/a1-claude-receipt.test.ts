import { test, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureBashReceipt } from "../src/runtime/receipt-capture";
import { freshReceiptFromFile } from "../src/tracking/receipts";
import { loadTrack } from "../src/tracking/store";

const made: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fh-a1-cc-"));
  made.push(d);
  return d;
};
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const T = 1_000_000_000_000;
const WIN = 365 * 24 * 3600 * 1000;

/** `tool_response` exactly as a real Claude Code PostToolUse Bash payload carries it (verified live: NO exit_code, `interrupted` explicit). */
const real = (stdout: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...extra });
const GREEN = "bun test v1.4.4 (38afee6c8)\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [7.00ms]";
const RED = "bun test v1.4.4 (38afee6c8)\n\n 0 pass\n 2 fail\n 2 expect() calls\nRan 2 tests across 1 file. [7.00ms]";
/** A red suite whose `fail` line was filtered away by a pipe stage: pass counted, no fail line. */
const FILTERED = "bun test v1.4.4 (38afee6c8)\n\n 2 pass\n 2 expect() calls\nRan 3 tests across 1 file. [7.00ms]";
/** Claude Code PostToolUse `tool_input` (`implied` context present = host claude-code, event PostToolUse). */
const IN = (extra: Record<string, unknown> = {}): { toolInput: Record<string, unknown> } => ({ toolInput: { command: "x", description: "d", ...extra } });

async function capture(file: string, command: string, response: unknown, ctx: { toolInput: Record<string, unknown> } | null = IN()): Promise<void> {
  await captureBashReceipt(file, "Bash", command, undefined, response, T, 43, ctx ?? undefined);
}
const receipts = async (file: string) => (await loadTrack(file)).receipts ?? [];

test("a1 claude receipt: plain `bun test` green (real payload, no exit_code) -> passing receipt with verifiedAt", async () => {
  const file = join(dir(), "t.json");
  await capture(file, "bun test ok.test.ts", real(GREEN));
  const r = freshReceiptFromFile(file, WIN, T + 1);
  expect(r?.kind).toBe("test");
  expect(r?.exitCode).toBe(0);
  expect(r?.verifiedAt).toBe(T - 43);
});

test("a1 claude receipt: plain `bun test` with fails (and `2>&1`) -> failing receipt; `2>&1` alone is fine", async () => {
  const file = join(dir(), "t.json");
  await capture(file, "bun test 2>&1", real(RED));
  expect(freshReceiptFromFile(file, WIN, T + 1)).toBeNull();
  expect((await receipts(file))[0]?.fail).toBe(2);
  const ok = join(dir(), "ok.json");
  await capture(ok, "bun test 2>&1", real(GREEN));
  expect(freshReceiptFromFile(ok, WIN, T + 1)?.kind).toBe("test");
});

test("a1 claude receipt: other hosts (no implied context) without exit_code -> no receipt (unchanged)", async () => {
  const file = join(dir(), "t.json");
  await capture(file, "bun test", real(GREEN), null);
  expect(await receipts(file)).toEqual([]);
});

test("a1 claude receipt: exit_code present keeps its exact behaviour (exit 1 -> never passing, exit 0 -> as before)", async () => {
  const bad = join(dir(), "a.json");
  await capture(bad, "bun test", real(GREEN, { exit_code: 1 }));
  expect(freshReceiptFromFile(bad, WIN, T + 1)).toBeNull();
  expect((await receipts(bad))[0]?.exitCode).toBe(1);
  const good = join(dir(), "b.json");
  await capture(good, "bun test | tail -5", real(GREEN, { exit_code: 0 }), null); // base behaviour, untouched
  expect((await receipts(good)).length).toBe(1);
});

test("a1 claude receipt: pipe filters that hide failures (challenger table) -> NO receipt, even though the pipeline exits 0", async () => {
  for (const cmd of [
    "bun test bad.test.ts 2>&1 | grep -v fail",
    "bun test 2>&1 | grep pass",
    "bun test 2>&1 | sed /fail/d",
    "bun test 2>&1 | tee x.log | grep -v fail",
    "go test ./... 2>&1 | grep -v FAIL",
  ]) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, real(FILTERED));
    expect(await receipts(file)).toEqual([]);
  }
});

test("a1 claude receipt: `bun test 2>&1 | tail -5` -> no receipt (documented trade-off: no tail/cat allowlist)", async () => {
  const file = join(dir(), "t.json");
  await capture(file, "bun test 2>&1 | tail -5", real(GREEN));
  expect(await receipts(file)).toEqual([]);
});

test("a1 claude receipt: lists, background `&`, subshells and substitutions -> no receipt", async () => {
  for (const cmd of [
    "bun test || true",
    "bun test; true",
    "cd sub && bun test",
    'git status --short && bun test && bunx tsc --noEmit; echo "tsc exit $?"',
    "bun test &",
    "(bun test)",
    "bun test $(echo x)",
    "bun test `echo x`",
    "bun test > out.log",
    "bun test\nexit 0",
  ]) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, real(GREEN));
    expect(await receipts(file)).toEqual([]);
  }
});

test("a1 claude receipt: shell metacharacters are checked on the RAW command (no quote masking): a quoted `|` is conservatively compound", async () => {
  const file = join(dir(), "t.json");
  await capture(file, 'bun test -t "a|b"', real(GREEN));
  expect(await receipts(file)).toEqual([]);
});

test("a1 claude receipt: background Bash (backgroundTaskId / run_in_background) never yields a receipt, tsc / go vet / bun test", async () => {
  for (const cmd of ["bunx tsc --noEmit", "go vet ./...", "bun test"]) {
    const bgResp = real("Command running in background with ID: bx1", { backgroundTaskId: "bx1" });
    const a = join(dir(), "a.json");
    await capture(a, cmd, bgResp, IN({ run_in_background: true }));
    const b = join(dir(), "b.json");
    await capture(b, cmd, real(GREEN, { backgroundTaskId: "bx1" })); // only the response marker
    const c = join(dir(), "c.json");
    await capture(c, cmd, real(""), IN({ run_in_background: true })); // only the input marker, empty stdout
    for (const f of [a, b, c]) expect(await receipts(f)).toEqual([]);
  }
});

test("a1 claude receipt: script launchers (exit = last command of an opaque package.json script) -> NO receipt", async () => {
  for (const cmd of ["npm test", "bun run test", "npm test --silent", "npm run test:filter", "yarn test", "pnpm test", "pnpm run test"]) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, real(GREEN));
    expect(await receipts(file)).toEqual([]);
  }
});

test("a1 claude receipt: DIRECT runners keep the implied exit 0 (owner's real usage): bun test, bunx tsc --noEmit, vitest, pytest, go test, cargo test", async () => {
  const cases: Array<[string, string]> = [
    ["bun test", GREEN],
    ["bunx tsc --noEmit", ""],
    ["npx vitest run", " Tests  3 passed (3)\n"],
    ["pytest -q", "3 passed in 0.10s\n"],
    ["go test ./...", "ok  \tex/a\t0.1s\n"],
    ["cargo test", "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"],
  ];
  for (const [cmd, out] of cases) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, real(out));
    expect((await receipts(file)).length).toBe(1);
  }
  const tsc = join(dir(), "tsc.json");
  await capture(tsc, "bunx tsc --noEmit", real(""));
  expect(freshReceiptFromFile(tsc, WIN, T + 1)?.kind).toBe("tsc");
});

test("a1 claude receipt: run_in_background is background unless exactly false/absent (string \"true\", \"false\", 1 -> no receipt)", async () => {
  for (const v of ["true", "false", 1, "yes"]) {
    const file = join(dir(), "t.json");
    await capture(file, "bun test", real(GREEN), IN({ run_in_background: v }));
    expect(await receipts(file)).toEqual([]);
  }
  const ok = join(dir(), "ok.json");
  await capture(ok, "bun test", real(GREEN), IN({ run_in_background: false }));
  expect((await receipts(ok)).length).toBe(1);
});

test("a1 claude receipt: `interrupted` must be explicitly false (missing / true / string -> no receipt)", async () => {
  for (const resp of [
    { stdout: GREEN, stderr: "" },
    real(GREEN, { interrupted: true }),
    real(GREEN, { interrupted: "true" }),
  ]) {
    const file = join(dir(), "t.json");
    await capture(file, "bun test", resp);
    expect(await receipts(file)).toEqual([]);
  }
});

test("a1 claude receipt: a response-less (PostToolUseFailure-shaped) call never yields a receipt", async () => {
  const file = join(dir(), "t.json");
  await capture(file, "bun test", undefined);
  expect(await receipts(file)).toEqual([]);
});

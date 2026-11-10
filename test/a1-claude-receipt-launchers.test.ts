import { test, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureBashReceipt } from "../src/runtime/receipt-capture";
import { loadTrack } from "../src/tracking/store";

const made: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fh-a1-cc-"));
  made.push(d);
  return d;
};
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const T = 1_000_000_000_000;
const VITEST = " Tests  3 passed (3)\n";
const JEST = "Tests:       3 passed, 3 total\n";
const PYTEST = "3 passed in 0.10s\n";

/** Real Claude Code PostToolUse Bash payload shape (no exit_code), host claude-code. */
async function capture(file: string, command: string, stdout: string): Promise<void> {
  const response = { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
  await captureBashReceipt(file, "Bash", command, undefined, response, T, 43, { toolInput: { command, description: "d" } });
}
const count = async (file: string): Promise<number> => ((await loadTrack(file)).receipts ?? []).length;

test("a1 claude receipt: `pnpm|yarn <bin>` without exec may run a same-name package.json script -> NO receipt", async () => {
  const cases: Array<[string, string]> = [
    ["pnpm jest", JEST],
    ["pnpm -s vitest", VITEST],
    ["pnpm --silent pytest", PYTEST],
    ["yarn jest", JEST],
    ["yarn vitest run", VITEST],
    ["pnpm vitest run", VITEST],
  ];
  for (const [cmd, out] of cases) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, out);
    expect(await count(file)).toBe(0);
  }
});

test("a1 claude receipt: `pnpm exec`, bunx, npx, uv run, python -m keep their implied exit 0", async () => {
  const cases: Array<[string, string]> = [
    ["pnpm exec vitest run", VITEST],
    ["pnpm -s exec vitest run", VITEST],
    ["bunx vitest run", VITEST],
    ["npx jest", JEST],
    ["uv run pytest -q", PYTEST],
    ["python3 -m pytest -q", PYTEST],
    ["vitest run", VITEST],
    ["pnpm --filter=api exec vitest run", VITEST],
    ["bun test 2>&1", "bun test v1.4.4\n\n 1 pass\n 0 fail\n"],
    ["bunx tsc --noEmit 2>&1", ""],
  ];
  for (const [cmd, out] of cases) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, out);
    expect(await count(file)).toBe(1);
  }
});

test("a1 claude receipt (F-A): a pnpm option VALUE named `exec` is not the exec subcommand -> NO receipt", async () => {
  for (const [cmd, out] of [["pnpm -C exec jest", JEST], ["pnpm --dir exec jest", JEST], ["pnpm -C exec vitest", VITEST]] as Array<[string, string]>) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, out);
    expect(await count(file)).toBe(0);
  }
});

test("a1 claude receipt (F-B): `2>&1=a` is not an fd duplication, the runner may never run -> NO receipt", async () => {
  for (const cmd of ["true 2>&1=a tsc", ": 2>&1=a tsc --noEmit", "true 2>&1=a go vet ./..."]) {
    const file = join(dir(), "t.json");
    await capture(file, cmd, "");
    expect(await count(file)).toBe(0);
  }
});

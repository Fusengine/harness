import { test, expect } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { RUBY_E_ANCHOR } from "../src/policy/guards/bash-write-patterns";
import type { GuardContext } from "../src/policy/guards/context";
import { REAL_CWD } from "./helpers/real-cwd";

/**
 * Frozen main-parity table for bashWriteGuard's ruby/node inline-script
 * detectors (owner-measured 2026-09-05 fix, 3 breaks):
 *  - Break 1 (miss): unanchored `ruby -e` let option forms
 *    (`-ryaml`/`-w`/`-we`/`-ne`/`--disable=gems`) slip past — fixed by
 *    {@link RUBY_E_ANCHOR}.
 *  - Break 2 (false block, allow→block regression): the same unanchored
 *    regex fired on a quoted MENTION at any position — fixed by CMD-anchoring
 *    the real detector; the pre-existing `git`/`rg` SAFE_PREFIXES
 *    short-circuit still returns null before any inline-script check runs.
 *  - Break 3 (loosening ask→allow regression): the unanchored fallback ask
 *    tier for `node -e`/`ruby -e` nested inside a wrapper (`docker run …`,
 *    `ssh host "…"`) that {@link RUBY_E_ANCHOR}/INLINE_JS_ANCHOR structurally
 *    cannot reach was restored verbatim after the SAFE_PREFIXES/redirect
 *    handling in bash-write.ts.
 *
 * `null` below means "no Prompt returned" (allow).
 */
const cmd = (command: string): GuardContext => ({ tool: "Bash", command, cwd: REAL_CWD });
type Verdict = "block" | "ask" | null;
const verdict = (command: string): Verdict => (bashWriteGuard(cmd(command))?.kind as Verdict) ?? null;

// --- (a) Break 1: ruby -e option-form anchoring -----------------------------

test("Break 1: 5 ruby option forms writing a code file all block", () => {
  const forms = [
    `ruby -ryaml -e 'File.write("src/x.ts","1")'`,
    `ruby -w -e 'File.write("src/x.ts","1")'`,
    `ruby -we 'File.write("src/x.ts","1")'`,
    `ruby -ne 'File.write("src/x.ts","1")'`,
    `ruby --disable=gems -e 'File.write("src/x.ts","1")'`,
  ];
  for (const command of forms) expect(verdict(command)).toBe("block");
});

test("Break 1: ruby -ryaml -e with no write API allows", () => {
  expect(verdict(`ruby -ryaml -e 'puts 1'`)).toBeNull();
});

test("Break 1: ruby -e writing a non-code file asks", () => {
  expect(verdict(`ruby -e 'File.write("notes.txt","1")'`)).toBe("ask");
});

// --- (b) Break 2: quoted mentions match main's verdict exactly --------------

test("Break 2: git commit mentioning 'ruby -e File.write' is null (SAFE_PREFIXES short-circuit)", () => {
  expect(verdict(`git commit -m "feat: block ruby -e File.write to src/x.ts"`)).toBeNull();
});

test("Break 2: rg mentioning 'ruby -e File.write' is null (SAFE_PREFIXES short-circuit)", () => {
  expect(verdict(`rg "ruby -e 'File.write" docs/`)).toBeNull();
});

test("Break 2: echo mentioning ruby -e + File.write matches main's measured verdict (ask)", () => {
  // Measured on main-wt bash-write.ts before this fix: main's unanchored
  // `/\bruby\s+-e\b/` + RUBY_WRITES also fires inside this quoted echo
  // argument. RUBY_E_ANCHOR correctly does NOT match here (not a command
  // position) — parity is preserved by the restored Break-3 fallback tier.
  expect(verdict(`echo "use ruby -e 'File.write(\\"a.rb\\")' here"`)).toBe("ask");
});

// --- (c) Break 3: nested nested wrappers keep their ask tier ----------------

test("Break 3: node -e write nested in docker run asks", () => {
  expect(verdict(`docker run --rm node:22 node -e '...writeFileSync("/tmp/x.ts","1")'`)).toBe("ask");
});

test("Break 3: node -e write nested in ssh asks", () => {
  expect(verdict(`ssh host "node -e '...writeFileSync(\\"src/x.ts\\",\\"1\\")'"`)).toBe("ask");
});

test("Break 3: ruby -e write nested in ssh asks", () => {
  expect(verdict(`ssh host "ruby -e 'File.write(\\"src/x.ts\\",\\"1\\")'"`)).toBe("ask");
});

test("Break 3: node -e with no write API nested in docker run allows", () => {
  expect(verdict(`docker run image node -e 'console.log(1)'`)).toBeNull();
});

// --- (d) Frozen differential parity table (>= 40 commands) ------------------

const PARITY_TABLE: readonly (readonly [string, Verdict])[] = [
  // Break 1
  [`ruby -ryaml -e 'File.write("src/x.ts","1")'`, "block"],
  [`ruby -w -e 'File.write("src/x.ts","1")'`, "block"],
  [`ruby -we 'File.write("src/x.ts","1")'`, "block"],
  [`ruby -ne 'File.write("src/x.ts","1")'`, "block"],
  [`ruby --disable=gems -e 'File.write("src/x.ts","1")'`, "block"],
  [`ruby -ryaml -e 'puts 1'`, null],
  [`ruby -e 'File.write("notes.txt","1")'`, "ask"],
  // Break 2
  [`git commit -m "feat: block ruby -e File.write to src/x.ts"`, null],
  [`rg "ruby -e 'File.write" docs/`, null],
  [`echo "use ruby -e 'File.write(\\"a.rb\\")' here"`, "ask"],
  // Break 3
  [`docker run --rm node:22 node -e '...writeFileSync("/tmp/x.ts","1")'`, "ask"],
  [`ssh host "node -e '...writeFileSync(\\"src/x.ts\\",\\"1\\")'"`, "ask"],
  [`ssh host "ruby -e 'File.write(\\"src/x.ts\\",\\"1\\")'"`, "ask"],
  [`docker run image node -e 'console.log(1)'`, null],
  // Other inline-runtime writers (block)
  [`bun -e 'require("fs").writeFileSync("src/x.ts","1")'`, "block"],
  [`node -pe 'require("fs").writeFileSync("src/x.ts","1")'`, "block"],
  [`perl -E 'system("touch src/x.ts")'`, "block"],
  [`node - <<'EOF'\nrequire("fs").writeFileSync("src/x.ts","1")\nEOF`, "block"],
  [`deno eval 'Deno.writeTextFileSync("src/x.ts","1")'`, "block"],
  [`BUN_X=1 bun -e 'require("fs").writeFileSync("src/x.ts","1")'`, "block"],
  [`env sed -i 's/a/b/' src/x.ts`, "block"],
  [`timeout 5 patch < a.diff`, "block"],
  [`sed -i 's/a/b/' src/x.ts`, "block"],
  [`awk -i inplace '{print}' src/x.ts`, "block"],
  [`perl -pi -e 's/a/b/' src/x.ts`, "block"],
  [`python3 -c "import os; os.remove('src/x.ts')"`, "block"],
  [`tee src/x.ts`, "block"],
  [`dd if=/dev/zero of=src/x.ts`, "block"],
  // Ask (non-code file writers)
  [`tee out.txt`, "ask"],
  [`dd if=/dev/zero of=out.txt`, "ask"],
  [`echo 1 >> out.log`, "block"], // literal text: Write/Edit tool instead (was ask on main)
  [`prog >> out.log`, "ask"],
  [`bun -e 'require("fs").writeFileSync("out.json","1")'`, "ask"],
  // Null (safe/read-only)
  [`bun test`, null],
  [`git status`, null],
  [`rg x`, null],
  [`ls`, null],
  [`cat a.ts`, null],
  [`npm run lint -- --fix`, null],
  [`FOO=1 grep x src/a.ts`, null],
  [`node -v`, null],
  [`python3 -c 'print(1)'`, null],
  [`cp a.ts b.ts`, null],
  [`mv a.ts b.ts`, null],
  [`mkdir -p foo`, null],
  [`biome check .`, null],
  [`tsc --noEmit`, null],
];

test(`frozen differential parity table (${PARITY_TABLE.length} commands, >= 40)`, () => {
  expect(PARITY_TABLE.length).toBeGreaterThanOrEqual(40);
  for (const [command, expected] of PARITY_TABLE) {
    expect(verdict(command)).toBe(expected);
  }
});

// --- ReDoS guard for RUBY_E_ANCHOR -------------------------------------------

test("RUBY_E_ANCHOR stays linear-time on a 2000-char pathological input", () => {
  const pathological = `ruby ${"-a ".repeat(700)}x`;
  expect(pathological.length).toBeGreaterThan(2000);
  const start = performance.now();
  RUBY_E_ANCHOR.test(pathological);
  const elapsedMs = performance.now() - start;
  expect(elapsedMs).toBeLessThan(5);
});

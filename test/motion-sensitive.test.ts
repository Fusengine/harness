import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bannedListPath, findSensitive, loadBannedTerms, redact } from "../src/policy/motion/sensitive";

const home = (): string => realpathSync(mkdtempSync(join(tmpdir(), "motion-sens-")));

test("banned.txt absent -> []", () => {
  expect(loadBannedTerms(home())).toEqual([]);
});

test("banned.txt: trimmed, blanks and # comments skipped, CRLF ok", () => {
  const h = home();
  mkdirSync(dirname(bannedListPath(h)), { recursive: true });
  writeFileSync(bannedListPath(h), "# c\r\n  Acme Corp  \r\n\r\nSecret\n");
  expect(loadBannedTerms(h)).toEqual(["Acme Corp", "Secret"]);
});

test("banned term is case-insensitive and NFC-normalized", () => {
  expect(findSensitive("we sign with ACME CORP today", ["Acme Corp"])).not.toBeNull();
  const decomposed = "café";
  expect(findSensitive(`visit ${decomposed}`, ["café"])).not.toBeNull();
  expect(findSensitive("visit CAFÉ", ["café"])).not.toBeNull();
  expect(findSensitive("nothing here", ["Acme Corp"])).toBeNull();
});

test("hit is redacted: the term never appears in clear", () => {
  const r = findSensitive("deal with Zanzibar Holdings", ["Zanzibar Holdings"]);
  expect(r).not.toBeNull();
  expect(r?.toLowerCase()).not.toContain("zanzibar");
  expect(r).not.toContain("Holdings");
  expect(redact("Secret")).toBe("S*****");
  expect(redact("ab")).toBe("**");
  expect(redact("x")).toBe("*");
  expect(redact("")).toBe("");
});

test("currency amounts are detected", () => {
  for (const s of ["12 €", "total 12 €", "1 299,50 EUR", "$1,299.00", "£ 40", "5 usd", "price: 3.50GBP", "12€"]) {
    expect(findSensitive(s, [])).not.toBeNull();
  }
});

test("versions, shell vars, plain numbers are not amounts", () => {
  for (const s of ["version 1.2.3", "echo $HOME", "const a = 1299", "fps 30, 1080 x 1920", "#3 of 12", "2026-10-08", "$USER $PATH"]) {
    expect(findSensitive(s, [])).toBeNull();
  }
});

test("`$1` back-reference in a replace call is not an amount (false positive fixed)", () => {
  expect(findSensitive('s.replace(/(x)/, "$1")', [])).toBeNull();
  expect(findSensitive('s.replaceAll(/(x)/g, "<$1>$2")', [])).toBeNull();
  expect(findSensitive("re.sub(r'(x)', r'\\1$1', s)", [])).toBeNull();
});

test("real amounts survive on lines that also hold a replace call", () => {
  expect(findSensitive('s.replace(/a/, "$1")\nconst price = "$5"', [])).not.toBeNull();
  expect(findSensitive('s.replace(/a/, "$1 and 40 €")', [])).not.toBeNull();
});

test("field references in a multi-line awk program are not amounts", () => {
  const script = ["#!/bin/sh", "awk '", "  { if ($3 > 0.5) n++ }", "  END { print n, $NF }", "' file.txt", "x=${2}"].join("\n");
  expect(findSensitive(script, [])).toBeNull();
  // `sh -c` bodies are out of scope (a positional `$2` and a price `$2` look alike): scanned as in dd8a2e1.
  expect(findSensitive("sh -c '\n  n=$2\n' ", [])).not.toBeNull();
});

test("real amounts inside an awk program body stay blocked", () => {
  expect(findSensitive("awk '\n  { if ($40 > 0) n++ }\n' f", [])).not.toBeNull();
  expect(findSensitive("awk '\n  { print $12.50 }\n' f", [])).not.toBeNull();
  expect(findSensitive("awk '\n  { if ($3 > 40 €) n++ }\n' f", [])).not.toBeNull();
  expect(findSensitive("awk '\n  { t = \"$1,299.00\" }\n' f", [])).not.toBeNull();
  expect(findSensitive("sh -c '\n  prix=$1,299.00\n'", [])).not.toBeNull();
});

test("stripping a reference never fuses neighbors into an amount (challenger round 2)", () => {
  // All were already allowed by dd8a2e1: the strip must not create a currency match.
  expect(findSensitive("awk '\n{ print €${2}5 }\n' f", [])).toBeNull();
  expect(findSensitive("awk '\n{ print £${10}40 }\n' f", [])).toBeNull();
  expect(findSensitive("gawk '\n{ print €${2}5 }\n' f", [])).toBeNull();
});

test("a prose apostrophe is not a program-body close (challenger round 2)", () => {
  // `c'est`: the apostrophe is followed by a letter, so the awk quote stays unclosed and nothing is stripped.
  expect(findSensitive("awk '{print}\nPrix $5 par mois\nc'est prêt", [])).not.toBeNull();
  expect(findSensitive("sh -c '{print}\nPrix $5\nn'est pas", [])).not.toBeNull();
  // A word glued to the closing quote (`'{print}'file`) must not extend the body to a later quote (challenger round 3).
  expect(findSensitive("awk '{print}'file\nAbonnement $9 par mois\nfin ' x", [])).not.toBeNull();
  expect(findSensitive("awk '{print}'1\nOnly $5 today\n'", [])).not.toBeNull();
});

test("awk only counts in shell command position, and an awk string keeps its amount (challenger round 4)", () => {
  const H = "<" + "<EOF";
  expect(findSensitive("awk '\n{print \"Only $5 today\"}\n' f", [])).not.toBeNull();
  expect(findSensitive("# exemple : awk '{print}\nAbonnement $9 par mois\n'", [])).not.toBeNull();
  expect(findSensitive(`cat ${H}\nawk '{print}\nPrix $9\n'\nEOF`, [])).not.toBeNull();
  expect(findSensitive("echo \"voir la commande\nawk '{print}\nPrix $9\n'\"", [])).not.toBeNull();
  expect(findSensitive("echo \"x; awk \"\nOnly $5 today\n\"", [])).not.toBeNull();
  expect(findSensitive("Pricing & awk-free plans: \"Starter\nOnly $5 per month\n\"", [])).not.toBeNull();
  expect(findSensitive("| awk | 'note\nOnly $5 today\n' |", [])).not.toBeNull();
  expect(findSensitive("Bref; awk 'est\nOnly $5 today\n' etc", [])).not.toBeNull();
  // An awk `#` comment or a bullet line inside the body keeps its amount.
  expect(findSensitive("awk 'BEGIN { print \"Pro\" }\n# Pro: $9\n' /dev/null", [])).not.toBeNull();
  expect(findSensitive("awk '{ print }\n- $9 pro\n' x", [])).not.toBeNull();
  // A real program after a closed comment or heredoc is still recognized.
  expect(findSensitive(`cat ${H}\ntexte\nEOF\nawk '\n{ if ($3 > 1) n++ }\n' f`, [])).toBeNull();
  expect(findSensitive("# compte\nawk '\n{ if ($3 > 1) n++ }\n' f", [])).toBeNull();
});

test("`$1` glued to a template-literal interpolation stays blocked (same shape as a real price)", () => {
  // `${a}$1` is indistinguishable from the real price `${cur}$5` without letting amounts through:
  // dd8a2e1 blocked both, and security wins (owner decision, pass 2).
  expect(findSensitive("const s = `${a}$1`;", [])).not.toBeNull();
  expect(findSensitive("const s = `$1${a}`;", [])).not.toBeNull();
  expect(findSensitive("const s = `Only $5${per}`;", [])).not.toBeNull();
});

test("single-digit dollar amounts outside field-reference contexts stay blocked", () => {
  for (const s of ["# coût $5", "pay ($5)", "ticket '$5'", "prix `$5`", "const s = `coût $5 pour ${n}`;"]) {
    expect(findSensitive(s, [])).not.toBeNull();
  }
});

test("challenger counter-examples: amounts behind any non-awk quote context stay blocked", () => {
  const SQ = "'";
  const cases = [
    "export const caption = `\n  Abonnement $9 par mois\n`;",
    "export default `\nOnly $5 today\n`;",
    "export function f() { return `\nPro: $9\n`; }",
    "exec(`\nprice $5\n`)",
    `echo l${SQ}animation démarre\n\nLe plan coûte $9 par mois.`,
    `echo ok # it${SQ}s fine\nPrice: $5`,
    `bash l${SQ}outil\nCoût $3`,
    `awk ${SQ}{print}\nPrix $5`,
    'echo "hello\nTotal $7',
    `echo ${SQ}x\r\nPrix $5\r\n`,
    `echo ${SQ}it\\${SQ}s\nPrix $5`,
    "cat <" + `<EOF\necho ${SQ}x\nPrix $5\nEOF`,
    "const s = `Only $5${per}`;",
    "`${cur}$5`",
    "Un ` isolé ${x}$5 ici",
    `{"cmd":"awk ${SQ}{print $1}${SQ}","prix":"$5"}`,
  ];
  for (const s of cases) {
    expect([s, findSensitive(s, [])]).toEqual([s, expect.any(String)]);
  }
});

test("field references in closed gawk/mawk and bash -c bodies are not amounts", () => {
  const SQ = "'";
  expect(findSensitive(`mawk ${SQ}\n { print $7 }\n${SQ} f`, [])).toBeNull();
  expect(findSensitive(`gawk ${SQ}\n { print $8 }\n${SQ} f`, [])).toBeNull();
  // `bash -c` and double-quoted awk programs (the shell expands `$3` there) stay scanned as in dd8a2e1.
  expect(findSensitive(`bash -c ${SQ}\n  n=$2\n${SQ}`, [])).not.toBeNull();
  expect(findSensitive(`awk "\n  { print $3 }\n" f`, [])).not.toBeNull();
});

test("an unclosed quote never weakens the scan (printf/export are not program bodies)", () => {
  // `\\` is an escaped backslash: the `"` after it genuinely closes, so line 2's
  // `$5` is a plain price line and must stay blocked (regression: odd/even parity).
  expect(findSensitive('export DIR="C:\\\\"\n$5 due', [])).not.toBeNull();
  // Odd run: the quote really is escaped and stays open, but printf is not an
  // awk/`sh -c` program body, so an unclosed quote changes nothing (dd8a2e1 blocked).
  expect(findSensitive('printf "a\\\" \n$2 due', [])).not.toBeNull();
});

test("a quote closed on a replace line never leaks program-body state", () => {
  expect(findSensitive("awk '\n{ print $3 }' ; s.replace(/x/, \"$1\n# coût $5", [])).not.toBeNull();
  expect(findSensitive("awk '\n{ n=$3\n  r = s.replace(/a/, \"$1\") }\n' f", [])).toBeNull();
  // An awk body with no `{ action }` is not provably a program (prose like `; awk 'est … '`): left as dd8a2e1 scanned it.
  expect(findSensitive("awk '\n  n=$3\n' f", [])).not.toBeNull();
});

test("long digit/space runs do not blow up (ReDoS guard)", () => {
  const t = Date.now();
  findSensitive("1 ".repeat(250_000), []);
  findSensitive("1,".repeat(250_000), []);
  expect(Date.now() - t).toBeLessThan(1500);
});

test("only the head of huge content is scanned", () => {
  expect(findSensitive(`${"a".repeat(600 * 1024)} 12 €`, [])).toBe('currency amount "1***"');
});

import { expect, test } from "bun:test";
import { findSensitive } from "../src/policy/motion/sensitive";

/**
 * Differential vs dd8a2e1 (pass 2): each entry carries the verdict of the
 * pre-fix implementation, recomputed on a base verified byte-for-byte against
 * `git show dd8a2e1:src/policy/motion/sensitive.ts` (sha256
 * 04f994a23d58061400733861f0e8081c225fafa6cec2bf7a498b615e6277dcd9).
 * Invariant: zero allow -> blocked anywhere; blocked -> allowed only in the
 * "field-ref" class (references inside an awk/gawk/mawk or `sh -c`/`bash -c`
 * program body opened AND closed by a quote in the same source).
 */
type Cls = "field-ref" | "amount" | "adverse" | "clean" | "banned";
interface Entry { name: string; cls: Cls; content: string; oldBlocked: boolean; terms?: string[] }

const E = (name: string, cls: Cls, content: string, oldBlocked: boolean, terms?: string[]): Entry =>
  ({ name, cls, content, oldBlocked, terms });

const SQ = "'";
const AWK = `awk ${SQ}\n  { if ($3 > 0.5) n++ }\n  END { print n, $NF }\n${SQ} file.txt\nx=\${2}`;

const CORPUS: Entry[] = [
  // --- field-reference class: the only allowed flips blocked -> allowed ---
  E("awk-multiline-$3/$NF/${2}", "field-ref", AWK, true),
  E("sh-c-multiline-$2", "adverse", `sh -c ${SQ}\n  n=$2\n${SQ}`, true),
  E("mawk-multiline-$7", "field-ref", `mawk ${SQ}\n { print $7 }\n${SQ} f`, true),
  E("gawk-multiline-$8", "field-ref", `gawk ${SQ}\n { print $8 }\n${SQ} f`, true),
  E("awk-multiline-double-quote", "adverse", 'awk "\n  { print $3 }\n" f', true),
  E("bash-ec-multiline-$4", "field-ref", `bash -ec ${SQ}\n echo $4\n${SQ}`, false),
  E("awk-single-line", "field-ref", `awk ${SQ}{ print $3 }${SQ} f`, false),
  E("echo-positional", "field-ref", 'echo "$1"', false),
  E("standalone-$3", "field-ref", "$3", false),
  E("standalone-${12}", "field-ref", "${12}", false),
  E("replace-call", "field-ref", 's.replace(/(x)/, "$1")', false),
  E("replaceAll-call", "field-ref", 's.replaceAll(/(x)/g, "<$1>$2")', false),
  E("python-sub", "field-ref", "re.sub(r'(x)', r'\\1$1', s)", false),
  // --- challenger counter-examples (pass-1 regression: must be BLOCK again) ---
  E("ce1-export-caption", "adverse", "export const caption = `\n  Abonnement $9 par mois\n`;", true),
  E("ce2-export-default", "adverse", "export default `\nOnly $5 today\n`;", true),
  E("ce3-export-fn", "adverse", "export function f() { return `\nPro: $9\n`; }", true),
  E("ce4-exec", "adverse", "exec(`\nprice $5\n`)", true),
  E("ce5-echo-fr", "adverse", `echo l${SQ}animation démarre\n\nLe plan coûte $9 par mois.`, true),
  E("ce6-echo-comment", "adverse", `echo ok # it${SQ}s fine\nPrice: $5`, true),
  E("ce7-bash-fr", "adverse", `bash l${SQ}outil\nCoût $3`, true),
  E("ce8-awk-unclosed", "adverse", `awk ${SQ}{print}\nPrix $5`, true),
  E("ce9-echo-dq-unclosed", "adverse", 'echo "hello\nTotal $7', true),
  E("ce10-crlf", "adverse", `echo ${SQ}x\r\nPrix $5\r\n`, true),
  E("ce11-sq-backslash", "adverse", `echo ${SQ}it\\${SQ}s\nPrix $5`, true),
  E("ce12-heredoc", "adverse", "cat <" + `<EOF\necho ${SQ}x\nPrix $5\nEOF`, true),
  E("ce13-tpl-price", "adverse", "const s = `Only $5${per}`;", true),
  E("ce14-tpl-cur", "adverse", "`${cur}$5`", true),
  E("ce15-tpl-isolated", "adverse", "Un ` isolé ${x}$5 ici", true),
  E("ce16-json-awk", "adverse", `{"cmd":"awk ${SQ}{print $1}${SQ}","prix":"$5"}`, true),
  // --- challenger round 2: fusion after strip (no flip; already allowed) ---
  E("fusion-€${2}5", "clean", `awk ${SQ}\n{ print €\${2}5 }\n${SQ} f`, false),
  E("fusion-£${10}40", "clean", `awk ${SQ}\n{ print £\${10}40 }\n${SQ} f`, false),
  E("fusion-$${2}5", "clean", `awk ${SQ}\n{ print $\${2}5 }\n${SQ} f`, false),
  // old blocked only on the `5$` artifact of the reference itself (awk syntax error `5$2`): in-class flip
  E("ref-artifact-5${2}€", "adverse", `awk ${SQ}\n{ print 5\${2}€ }\n${SQ} f`, true),
  // --- challenger round 2: a prose apostrophe is not a program-body close ---
  E("apostrophe-c'est", "adverse", `awk ${SQ}{print}\nPrix $5 par mois\nc${SQ}est prêt`, true),
  E("apostrophe-n'est", "adverse", `sh -c ${SQ}{print}\nPrix $5\nn${SQ}est pas`, true),
  // --- blocked invariants (any extension) ---
  E("$1,299.00", "amount", "$1,299.00", true),
  E("$ 40", "amount", "$ 40", true),
  E("12 €", "amount", "12 €", true),
  E("1 299,50 EUR", "amount", "1 299,50 EUR", true),
  E("£ 40", "amount", "£ 40", true),
  E("$40", "amount", "$40", true),
  E("$1 299", "amount", "$1 299", true),
  E("$12.50", "amount", "$12.50", true),
  E("€5", "amount", "€5", true),
  E("echo-price-49.99", "amount", 'echo "Prix : $49.99"', true),
  E("comment-$300", "amount", "# coût $300", true),
  E("5 usd", "amount", "total 5 usd", true),
  E("3.50GBP", "amount", "price: 3.50GBP", true),
  E("12€", "amount", "12€", true),
  E("£5", "amount", "£5", true),
  E("invoice-$2,000", "amount", "invoice $2,000 due", true),
  // --- amounts inside a CLOSED awk/`sh -c` body stay blocked ---
  E("awk-body-$40", "amount", `awk ${SQ}\n  { if ($40 > 0) n++ }\n${SQ} f`, true),
  E("awk-body-$1,299.00", "amount", `awk ${SQ}\n  { t = "$1,299.00" }\n${SQ} f`, true),
  E("awk-body-$12.50", "amount", `awk ${SQ}\n  { print $12.50 }\n${SQ} f`, true),
  E("awk-body-40€", "amount", `awk ${SQ}\n  { if ($3 > 40 €) n++ }\n${SQ} f`, true),
  E("awk-body-$-40", "amount", `awk ${SQ}\n  { print $ 40 }\n${SQ} f`, true),
  E("sh-c-body-$1,299.00", "amount", `sh -c ${SQ}\n  prix=$1,299.00\n${SQ}`, true),
  // --- adverse single-digit vectors ---
  E("comment-$5", "adverse", "# coût $5", true),
  E("paren-($5)", "adverse", "pay ($5)", true),
  E("single-quoted-'$5'", "adverse", "ticket '$5'", true),
  E("md-code-`$5`", "adverse", "prix `$5`", true),
  E("template-price-$5", "adverse", "const s = `coût $5 pour ${n}`;", true),
  E("template-price-49.99", "adverse", "const s = `Prix : $49.99 ${n}`", true),
  E("template-free-$1", "adverse", "const s = `${a}\n  unit $1\n`;", true),
  E("template-glue-left", "adverse", "const s = `${a}$1`;", true),
  E("template-glue-right", "adverse", "const s = `$1${a}`;", true),
  E("replace-line-quote-leak", "adverse", `awk ${SQ}\n{ print $3 }${SQ} ; s.replace(/x/, "$1\n# coût $5`, true),
  E("printf-unclosed-$2", "adverse", 'printf "a\\" \n$2 due', true),
  // --- clean non-amounts ---
  E("template-glue-multiline", "clean", "const s = `${a}\n$1\n`;", false),
  E("version", "clean", "version 1.2.3", false),
  E("echo-$HOME", "clean", "echo $HOME", false),
  E("plain-number", "clean", "const a = 1299", false),
  E("fps", "clean", "fps 30, 1080 x 1920", false),
  E("issue-ref", "clean", "#3 of 12", false),
  E("date", "clean", "2026-10-08", false),
  E("shell-vars", "clean", "$USER $PATH", false),
  E("awk-$NF-only", "clean", "awk '{ print $NF }' f", false),
  E("prose", "clean", "nothing sensitive here", false),
  // --- banned terms (byte-identical path) ---
  E("banned-hit", "banned", "we sign with ACME CORP", true, ["Acme Corp"]),
  E("banned-clean", "banned", "no match here", false, ["Acme Corp"]),
];

test("differential vs dd8a2e1: flips only in the field-ref class, never allow -> blocked", () => {
  for (const e of CORPUS) {
    const blocked = findSensitive(e.content, e.terms ?? []) !== null;
    const expected = e.cls === "field-ref" && e.oldBlocked ? false : e.oldBlocked;
    expect([e.name, blocked]).toEqual([e.name, expected]);
    if (!e.oldBlocked) expect([e.name, blocked]).toEqual([e.name, false]); // zero allow -> blocked
  }
});

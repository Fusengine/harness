/**
 * @module security/scan/patterns/js
 * JS/TS family rules (js jsx mjs cjs ts tsx mts cts vue svelte astro).
 * Legacy rules first, then new ones. New rules require a non-literal argument
 * or interpolation; `\x60` is a backtick. Legacy rules run only on files the
 * legacy scanner read; the `*-dynamic` rules are their precise counterparts
 * for every other file (a same-CWE hit on a legacy line is deduplicated).
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { rule as r, SQL_VERBS as SQL } from "./define";
import { LEGACY_JS } from "./legacy";

/** Rules for the JS/TS family. */
export const JS_RULES: ScanPattern[] = [
  ...LEGACY_JS,
  r("js.exec.eval-dynamic", "HIGH", "CODE_EXEC", "CWE-95", String.raw`(?<![\w$.])eval\s*\(\s*[^\s)"'\x60]`),
  r("js.exec.new-function-dynamic", "HIGH", "CODE_EXEC", "CWE-95", String.raw`\bnew\s+Function\s*\(\s*[^\s)"'\x60]`),
  r("js.cmd.spawn-shell", "MEDIUM", "CMD_INJECTION", "CWE-78", String.raw`\bshell\s*:\s*true\b`),
  r("js.xss.react-dsih", "HIGH", "XSS", "CWE-79",
    String.raw`\bdangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:(?!\s*["'][^"'\x60$]*["']\s*\})(?!\s*\x60[^\x60$]*\x60\s*\})`),
  r("js.exec.timer-string", "MEDIUM", "CODE_EXEC", "CWE-95", String.raw`\bset(?:Timeout|Interval)\s*\(\s*["'\x60]`),
  r("js.exec.vm-run", "HIGH", "CODE_EXEC", "CWE-94", String.raw`\bvm\.run(?:InNewContext|InThisContext|InContext)\s*\(\s*[^\s)"'\x60]`),
  r("js.cmd.exec-interp", "CRITICAL", "CMD_INJECTION", "CWE-78",
    String.raw`(?:(?<![\w$.])|\b(?:child_process|cp|childProcess)\.)(?:exec|execSync)\s*\(\s*(?:\x60[^\x60\n]*\$\{|(?:"[^"\n]*"|'[^'\n]*')\s*\+)`),
  r("js.xss.innerhtml-dynamic", "HIGH", "XSS", "CWE-79", String.raw`\.(?:inner|outer)HTML\s*\+?=(?!=)\s*(?:[^\s"'\x60;]|\x60[^\x60\n]*\$\{)`),
  r("js.xss.document-write", "HIGH", "XSS", "CWE-79",
    String.raw`\bdocument\.write(?:ln)?\s*\(\s*[^\s)"'\x60]|\binsertAdjacentHTML\s*\([^,)\n]{1,40},\s*[^\s)"'\x60]`),
  r("js.xss.framework-html", "MEDIUM", "XSS", "CWE-79",
    String.raw`\bv-html\s*=|\{@html\s|\bset:html\s*=|\bbypassSecurityTrust(?:Html|Script|Url|ResourceUrl|Style)\s*\(`),
  r("js.sql.concat", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`(?:\b(?:query|execute|raw)|(?:query|execute)RawUnsafe)\s*\(\s*(?:\x60[^\x60]{0,300}?\b${SQL}\b[^\x60]{0,300}?\$\{|["'][^"'\n]{0,300}\b${SQL}\b[^"'\n]{0,300}["']\s*\+)`, "i"),
  r("js.deser.node-serialize", "CRITICAL", "DESERIALIZATION", "CWE-502",
    String.raw`\.unserialize\s*\(\s*[^\s)"'\x60]|\brequire\s*\(\s*["']node-serialize["']\s*\)|\bfrom\s+["']node-serialize["']`),
  r("js.crypto.weak-hash", "MEDIUM", "WEAK_CRYPTO", "CWE-328",
    String.raw`\bcreateHash\s*\(\s*["'\x60](?:md[245]|sha-?1)["'\x60]\s*\)|\bCryptoHasher\s*\(\s*["'](?:md[245]|sha1)["']|\bdigest\s*\(\s*["']SHA-1["']`, "i"),
  r("js.crypto.create-cipher", "HIGH", "WEAK_CRYPTO", "CWE-327", String.raw`\bcreate(?:Cipher|Decipher)\s*\(`),
  r("js.crypto.weak-cipher", "HIGH", "WEAK_CRYPTO", "CWE-327",
    String.raw`\bcreate(?:Cipheriv|Decipheriv)\s*\(\s*["'\x60](?:des|des3|des-ede3?|rc[24]|bf|blowfish|aes-(?:128|192|256)-ecb)\b`, "i"),
  r("js.crypto.math-random-secret", "HIGH", "WEAK_CRYPTO", "CWE-338",
    String.raw`(?:token|secret|password|passwd|apikey|api_key|session|nonce|csrf|otp|salt)\w{0,40}\s*[:=][^;\n]{0,80}\bMath\.random\s*\(`, "i"),
  r("js.tls.disabled", "HIGH", "TLS", "CWE-295",
    String.raw`\brejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["'\x60]?0\b`),
];

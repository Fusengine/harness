/**
 * @module security/scan/patterns/native
 * Swift, Go and Rust rule tables (legacy Swift rules first).
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { rule as r, SQL_VERBS as SQL } from "./define";
import { LEGACY_SWIFT } from "./legacy";

const DB = String.raw`(?:Query|QueryRow|Exec|QueryContext|QueryRowContext|ExecContext)`;
const SH = String.raw`(?:sh|bash|/bin/sh|/bin/bash|cmd(?:\.exe)?)`;

/** Swift rules (swift). */
export const SWIFT_RULES: ScanPattern[] = [
  ...LEGACY_SWIFT,
  r("swift.deser.nskeyed-insecure", "HIGH", "DESERIALIZATION", "CWE-502", String.raw`\bNSKeyedUnarchiver\.unarchiveObject\w*\s*\(|\brequiresSecureCoding\s*=\s*false\b`),
  r("swift.storage.userdefaults-key", "MEDIUM", "INSECURE_STORAGE", "CWE-312",
    String.raw`UserDefaults\.standard\.set\s*\([^\n]{0,80}forKey\s*:\s*"[^"\n]*(?:password|passwd|secret|token|apikey|api_key|credential)[^"\n]*"`, "i"),
  r("swift.crypto.cc-md5", "MEDIUM", "WEAK_CRYPTO", "CWE-328", String.raw`\bCC_(?:MD5|SHA1)\s*\(|\bInsecure\.(?:MD5|SHA1)\b`),
];

/** Go rules (go). */
export const GO_RULES: ScanPattern[] = [
  r("go.cmd.exec-shell", "HIGH", "CMD_INJECTION", "CWE-78",
    String.raw`\bexec\.Command(?:Context)?\s*\(\s*(?:[\w.]+\s*,\s*)?"${SH}"\s*,\s*"(?:-c|/[cC])"\s*,(?!\s*"[^"\n]*"\s*\))\s*\S`),
  r("go.sql.format", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\b${DB}\s*\(\s*(?:[\w.]+\s*,\s*)?(?:fmt\.Sprintf\s*\(\s*"[^"\n]{0,300}\b${SQL}\b|"[^"\n]{0,300}\b${SQL}\b[^"\n]{0,300}"\s*\+)`, "i"),
  r("go.tls.skip-verify", "HIGH", "TLS", "CWE-295", String.raw`\bInsecureSkipVerify\s*:\s*true\b`),
  r("go.crypto.weak-import", "MEDIUM", "WEAK_CRYPTO", "CWE-327", String.raw`"crypto/(?:md5|sha1|des|rc4)"`),
  r("go.crypto.math-rand-secret", "HIGH", "WEAK_CRYPTO", "CWE-338",
    String.raw`(?:token|secret|password|passwd|key|nonce|salt|session|otp)\w{0,40}\s*(?::=|=)[^\n]{0,80}\brand\.(?:Int\w*|Uint\w*|Float\w*|Read|Perm|Shuffle)\s*\(`, "i",
    /"math\/rand(?:\/v2)?"/),
  r("go.xss.template-html", "HIGH", "XSS", "CWE-79", String.raw`\btemplate\.(?:HTML|JS|JSStr|URL|CSS|HTMLAttr)\s*\(\s*[^\s)"]`),
];

/** Rust rules (rs). */
export const RUST_RULES: ScanPattern[] = [
  r("rust.unsafe.block", "LOW", "UNSAFE_MEMORY", "CWE-242", String.raw`\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)`),
  r("rust.unsafe.risky-call", "MEDIUM", "UNSAFE_MEMORY", "CWE-119",
    String.raw`\b(?:mem::transmute|slice::from_raw_parts(?:_mut)?|get_unchecked(?:_mut)?|set_len|from_utf8_unchecked|assume_init)\b`),
  r("rust.cmd.shell-c", "HIGH", "CMD_INJECTION", "CWE-78",
    String.raw`\bCommand::new\s*\(\s*"(?:sh|bash|/bin/sh|/bin/bash|cmd(?:\.exe)?|powershell)"\s*\)\s*\.\s*args?\s*\(\s*(?:&?\[\s*)?"(?:-c|/[cC]|-Command)"`),
  r("rust.sql.format", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\bformat!\s*\(\s*"[^"\n]{0,200}\b(?:SELECT\b[^"\n]{0,200}\bFROM|INSERT\s+INTO|UPDATE\b[^"\n]{0,200}\bSET|DELETE\s+FROM)\b[^"\n]{0,200}\{`),
  r("rust.tls.invalid", "HIGH", "TLS", "CWE-295", String.raw`\bdanger_accept_invalid_(?:certs|hostnames)\s*\(\s*true\s*\)`),
  r("rust.crypto.weak-hash", "MEDIUM", "WEAK_CRYPTO", "CWE-328",
    String.raw`\buse\s+(?:md5|md-5|md_5|sha1|sha-1|sha_1)\b|\b(?:Md5|Sha1)::(?:new|digest)\s*\(|\bmd5::compute\s*\(`),
];

/**
 * @module security/scan/patterns/php-py
 * PHP and Python rule tables (legacy rules first). `\x60` is a backtick.
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { rule as r, SQL_VERBS as SQL } from "./define";
import { LEGACY_PHP, LEGACY_PY } from "./legacy";

/** PHP rules (php phtml inc). */
export const PHP_RULES: ScanPattern[] = [
  ...LEGACY_PHP,
  r("php.exec.eval-dynamic", "CRITICAL", "CODE_EXEC", "CWE-95", String.raw`(?<![\w$>:])(?:eval|create_function)\s*\(\s*[^\s)"']`),
  r("php.cmd.exec-family", "CRITICAL", "CMD_INJECTION", "CWE-78",
    String.raw`(?<![\w$>:])(?:system|exec|shell_exec|passthru|popen|proc_open|pcntl_exec)\s*\(\s*(?:[^\s)"']|"[^"\n]*\$|'[^'\n]*'\s*\.)`),
  r("php.cmd.backtick", "CRITICAL", "CMD_INJECTION", "CWE-78", String.raw`\x60[^\x60\n]*\$[A-Za-z_{][^\x60\n]*\x60`),
  r("php.deser.unserialize", "HIGH", "DESERIALIZATION", "CWE-502", String.raw`(?<![\w$>:])unserialize\s*\(\s*[^\s)"']`),
  r("php.sql.concat", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`(?:\bmysqli_query\s*\([^,\n]{1,60},|\bmysql_query\s*\(|\bpg_query\s*\([^,\n]{1,60},|->(?:query|exec)\s*\()\s*(?:"[^"\n]*\$|"[^"\n]*"\s*\.|'[^'\n]*'\s*\.)`),
  r("php.include.user", "CRITICAL", "PATH_TRAVERSAL", "CWE-98", String.raw`\b(?:include|include_once|require|require_once)\b\s*\(?[^;\n]{0,40}\$_(?:GET|POST|REQUEST|COOKIE)`),
  r("php.crypto.md5-password", "HIGH", "WEAK_CRYPTO", "CWE-916", String.raw`\b(?:md5|sha1)\s*\(\s*\$\w{0,40}(?:pass|pwd)`, "i"),
  r("php.crypto.rand-secret", "HIGH", "WEAK_CRYPTO", "CWE-338",
    String.raw`\$\w{0,40}(?:token|secret|password|nonce|salt|otp)\w{0,40}\s*=[^;\n]{0,80}\b(?:rand|mt_rand|uniqid|lcg_value)\s*\(`, "i"),
];

/** Python rules (py). */
export const PY_RULES: ScanPattern[] = [
  ...LEGACY_PY,
  r("py.exec.eval-dynamic", "HIGH", "CODE_EXEC", "CWE-95", String.raw`(?<![\w.])(?:eval|exec)\s*\(\s*[^\s)"']`),
  r("py.cmd.subprocess-shell", "HIGH", "CMD_INJECTION", "CWE-78", String.raw`\bsubprocess\.\w+\s*\([^\n]{0,200}?\bshell\s*=\s*True\b`),
  r("py.deser.pickle-family", "HIGH", "DESERIALIZATION", "CWE-502",
    String.raw`\b(?:pickle|cPickle|dill|shelve|marshal|jsonpickle)\.(?:loads?|Unpickler|decode)\s*\(|\bpandas\.read_pickle\s*\(`),
  r("py.deser.yaml-load", "HIGH", "DESERIALIZATION", "CWE-502", String.raw`\byaml\.load\s*\((?![^\n]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)`),
  r("py.cmd.os-system", "HIGH", "CMD_INJECTION", "CWE-78", String.raw`\bos\.(?:system|popen)\s*\(\s*(?:[A-Za-z_]|["'][^"'\n]*["']\s*(?:\+|%|\.format))`),
  r("py.tls.disabled", "HIGH", "TLS", "CWE-295", String.raw`\bverify\s*=\s*False\b|\bssl\._create_unverified_context\b|\bcheck_hostname\s*=\s*False\b|\bssl\.CERT_NONE\b`),
  r("py.crypto.weak-hash", "MEDIUM", "WEAK_CRYPTO", "CWE-328", String.raw`\bhashlib\.(?:md5|sha1)\s*\(|\bhashlib\.new\s*\(\s*["'](?:md5|sha1)["']`),
  r("py.sql.format", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\.(?:execute|executemany|raw|read_sql(?:_query)?|text)\s*\(\s*(?:[fF]["'][^"'\n]{0,300}\b${SQL}\b[^"'\n]{0,300}\{|["'][^"'\n]{0,300}\b${SQL}\b[^"'\n]{0,300}["']\s*(?:%|\+|\.format))`, "i"),
  r("py.crypto.random-secret", "HIGH", "WEAK_CRYPTO", "CWE-338",
    String.raw`\b(?:token|secret|password|passwd|nonce|salt|session|otp|csrf|api_?key)\w{0,40}\s*=[^\n]{0,80}\brandom\.(?:random|randint|choice|choices|randrange|getrandbits)\s*\(`, "i"),
];

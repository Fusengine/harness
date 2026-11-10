/**
 * @module security/scan/patterns/legacy
 * The 18 pre-coverage rules (main 6c1041f): regex, severity and category are
 * frozen so every legacy finding tuple survives. Severities therefore stay as
 * they were (child_process CRITICAL, mysql_query HIGH). Only id/cwe are new.
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { legacyRule as L } from "./define";

/** Legacy JavaScript rules (now applied to the whole JS/TS family). */
export const LEGACY_JS: ScanPattern[] = [
  L("js.xss.innerhtml-assign", "HIGH", "XSS", "CWE-79", /innerHTML\s*=/),
  L("js.xss.dangerously-set", "HIGH", "XSS", "CWE-79", /dangerouslySetInnerHTML/),
  L("js.exec.eval", "CRITICAL", "CODE_EXEC", "CWE-95", /eval\(/),
  L("js.exec.new-function", "CRITICAL", "CODE_EXEC", "CWE-95", /new Function\(/),
  L("js.cmd.child-process", "CRITICAL", "CMD_INJECTION", "CWE-78", /child_process/),
  L("js.cmd.shell-true", "HIGH", "CMD_INJECTION", "CWE-78", /shell:\s*true/),
  L("js.crypto.math-random", "MEDIUM", "WEAK_CRYPTO", "CWE-338", /Math\.random\(\)/),
  L("js.secret.akia", "CRITICAL", "SECRETS", "CWE-798", /AKIA[0-9A-Z]{16}/),
];

/** Legacy PHP rules. */
export const LEGACY_PHP: ScanPattern[] = [
  L("php.cmd.shell-exec-system", "CRITICAL", "RCE", "CWE-78", /shell_exec|system\(|passthru\(/),
  L("php.exec.eval-assert", "CRITICAL", "CODE_EXEC", "CWE-95", /eval\(|assert\(/),
  L("php.sql.mysql-query", "HIGH", "SQL_INJECTION", "CWE-89", /mysql_query\(/),
];

/** Legacy Python rules. */
export const LEGACY_PY: ScanPattern[] = [
  L("py.exec.eval-exec", "CRITICAL", "CODE_EXEC", "CWE-95", /eval\(|exec\(/),
  L("py.cmd.os-system-shell", "CRITICAL", "CMD_INJECTION", "CWE-78", /os\.system\(|subprocess.*shell=True/),
  L("py.deser.pickle-loads", "HIGH", "DESERIALIZATION", "CWE-502", /pickle\.loads\(/),
  L("py.tls.verify-false", "HIGH", "TLS", "CWE-295", /verify=False|ssl\.CERT_NONE/),
];

/** Legacy Swift rules. */
export const LEGACY_SWIFT: ScanPattern[] = [
  L("swift.storage.userdefaults-secret", "HIGH", "INSECURE_STORAGE", "CWE-312", /UserDefaults.*password|token|secret/),
  L("swift.net.http-literal", "MEDIUM", "INSECURE_HTTP", "CWE-319", /"http:\/\//),
  L("swift.keychain.accessible-always", "HIGH", "WEAK_KEYCHAIN", "CWE-311", /kSecAttrAccessibleAlways/),
];

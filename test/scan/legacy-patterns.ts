/**
 * @module test/scan/legacy-patterns
 * FROZEN verbatim copy of the pre-coverage scanner pattern table (main 6c1041f).
 * Test-only reference for the "legacy output is a subset of new output" guard.
 * Never edit the rules: they are the regression baseline.
 */

/** Vulnerability severity level (drives the summary counters). */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** A single scan rule: a regex applied to files matching `glob`. */
export interface ScanPattern {
  severity: Severity;
  category: string;
  regex: RegExp;
  glob: string;
}

/** OWASP scan patterns keyed by detected language (ported 1:1 from Python). */
const PATTERNS: Record<string, ScanPattern[]> = {
  javascript: [
    { severity: "HIGH", category: "XSS", regex: /innerHTML\s*=/, glob: "*.js" },
    { severity: "HIGH", category: "XSS", regex: /dangerouslySetInnerHTML/, glob: "*.js" },
    { severity: "CRITICAL", category: "CODE_EXEC", regex: /eval\(/, glob: "*.js" },
    { severity: "CRITICAL", category: "CODE_EXEC", regex: /new Function\(/, glob: "*.js" },
    { severity: "CRITICAL", category: "CMD_INJECTION", regex: /child_process/, glob: "*.js" },
    { severity: "HIGH", category: "CMD_INJECTION", regex: /shell:\s*true/, glob: "*.js" },
    { severity: "MEDIUM", category: "WEAK_CRYPTO", regex: /Math\.random\(\)/, glob: "*.js" },
    { severity: "CRITICAL", category: "SECRETS", regex: /AKIA[0-9A-Z]{16}/, glob: "*.js" },
  ],
  php: [
    { severity: "CRITICAL", category: "RCE", regex: /shell_exec|system\(|passthru\(/, glob: "*.php" },
    { severity: "CRITICAL", category: "CODE_EXEC", regex: /eval\(|assert\(/, glob: "*.php" },
    { severity: "HIGH", category: "SQL_INJECTION", regex: /mysql_query\(/, glob: "*.php" },
  ],
  python: [
    { severity: "CRITICAL", category: "CODE_EXEC", regex: /eval\(|exec\(/, glob: "*.py" },
    { severity: "CRITICAL", category: "CMD_INJECTION", regex: /os\.system\(|subprocess.*shell=True/, glob: "*.py" },
    { severity: "HIGH", category: "DESERIALIZATION", regex: /pickle\.loads\(/, glob: "*.py" },
    { severity: "HIGH", category: "TLS", regex: /verify=False|ssl\.CERT_NONE/, glob: "*.py" },
  ],
  swift: [
    { severity: "HIGH", category: "INSECURE_STORAGE", regex: /UserDefaults.*password|token|secret/, glob: "*.swift" },
    { severity: "MEDIUM", category: "INSECURE_HTTP", regex: /"http:\/\//, glob: "*.swift" },
    { severity: "HIGH", category: "WEAK_KEYCHAIN", regex: /kSecAttrAccessibleAlways/, glob: "*.swift" },
  ],
};

/** Return the scan patterns for a language ("" / go / rust / unknown → none). */
export function getPatterns(lang: string): ScanPattern[] {
  return PATTERNS[lang] ?? [];
}

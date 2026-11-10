/**
 * @module security/scan/patterns/secrets
 * Language-agnostic secret rules, applied to every scanned file (source and
 * config/text). Prefix-anchored token formats follow gitleaks and the GitHub
 * supported-patterns list; placeholders (`${X}`, `process.env`, `$`, `<`, `{`)
 * are excluded by the value character class.
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { rule as r } from "./define";

/** Secret rules (all files). */
export const SECRET_RULES: ScanPattern[] = [
  r("any.secret.hardcoded", "MEDIUM", "SECRETS", "CWE-798",
    String.raw`\b(?:password|passwd|pwd|secret|api_?key|access_?key|auth_?token|private_?key)\w{0,40}\s*[:=]\s*["'](?!\w{2,10}:\/\/)(?![^"'\s]{0,60}(?:example|changeme|xxx|placeholder|your[_-]|redacted|dummy))[^"'\s$<{%]{8,}["']`, "i"),
  r("any.secret.conn-string", "HIGH", "SECRETS", "CWE-798",
    String.raw`\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqps?):\/\/[^\s:@\/"'$<{]+:[^\s@\/"'$<{]+@`, "i"),
  r("sec.key.private", "CRITICAL", "SECRETS", "CWE-321",
    String.raw`-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----`),
  r("sec.aws.access-key", "HIGH", "SECRETS", "CWE-798", String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b`),
  r("sec.aws.secret-key", "CRITICAL", "SECRETS", "CWE-798",
    String.raw`\baws_?secret_?access_?key\w{0,40}\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}(?![A-Za-z0-9\/+=])`, "i"),
  r("sec.github.token", "CRITICAL", "SECRETS", "CWE-798",
    String.raw`\bgh[pour]_[A-Za-z0-9]{36,255}\b|\bghs_[A-Za-z0-9_.-]{36,}|\bgithub_pat_[A-Za-z0-9_]{82}\b`),
  r("sec.slack.token", "HIGH", "SECRETS", "CWE-798",
    String.raw`\bxoxb-[0-9]{10,13}-[0-9]{10,13}[A-Za-z0-9-]*|\bxox[pe](?:-[0-9]{10,13}){3}-[A-Za-z0-9-]{28,34}|\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+|\bxox[os]-\d+-\d+-\d+-[a-fA-F0-9]+`),
  r("sec.stripe.live-key", "CRITICAL", "SECRETS", "CWE-798", String.raw`\b[sr]k_live_[A-Za-z0-9]{24,99}\b`),
  r("sec.google.api-key", "MEDIUM", "SECRETS", "CWE-798", String.raw`\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`),
  r("sec.npm.token", "CRITICAL", "SECRETS", "CWE-798", String.raw`\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*[A-Za-z0-9_-]{20,}`),
  r("sec.openai.key", "CRITICAL", "SECRETS", "CWE-798",
    String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}`),
  r("sec.anthropic.key", "CRITICAL", "SECRETS", "CWE-798", String.raw`\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,}`),
];

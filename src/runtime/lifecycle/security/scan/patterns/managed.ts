/**
 * @module security/scan/patterns/managed
 * Ruby, JVM (Java + Kotlin) and C# rule tables.
 * @packageDocumentation
 */
import type { ScanPattern } from "../types";
import { rule as r, SQL_VERBS as SQL } from "./define";

/** Ruby rules (rb rake erb). */
export const RUBY_RULES: ScanPattern[] = [
  r("rb.exec.eval", "HIGH", "CODE_EXEC", "CWE-95", String.raw`(?<![\w.:])eval\s*\(\s*[^\s)"']`),
  r("rb.cmd.interp", "CRITICAL", "CMD_INJECTION", "CWE-78",
    String.raw`(?:(?<![\w.:])(?:system|exec|spawn)\s{0,20}\(?\s{0,20}|\bKernel\.(?:system|exec|spawn)\s{0,20}\(?\s{0,20})"[^"\n]{0,200}#\{|%x[{(\[][^})\]\n]{0,200}#\{|\x60[^\x60\n]{0,200}#\{[^\x60\n]{0,200}\x60`),
  r("rb.deser.marshal", "HIGH", "DESERIALIZATION", "CWE-502", String.raw`\bMarshal\.(?:load|restore)\s*\(|\b(?:YAML|Psych)\.unsafe_load\w*\s*\(`),
  r("rb.sql.interp", "CRITICAL", "SQL_INJECTION", "CWE-89", String.raw`\.(?:where|find_by_sql|execute|exec_query|order|joins|select)\s*\(\s*"[^"\n]*#\{`),
  r("rb.crypto.weak-hash", "MEDIUM", "WEAK_CRYPTO", "CWE-328", String.raw`\b(?:OpenSSL::)?Digest::(?:MD5|SHA1)\b`),
  r("rb.tls.verify-none", "HIGH", "TLS", "CWE-295", String.raw`\bverify_mode\s*=\s*OpenSSL::SSL::VERIFY_NONE\b`),
];

const RANDOM_SECRET = r("jvm.crypto.random-secret", "HIGH", "WEAK_CRYPTO", "CWE-338",
  String.raw`\b(?:token|secret|password|nonce|salt|session|otp|csrf)\w{0,40}\s*=[^;\n]{0,80}\b(?:new\s+Random\s*\(|Random\s*\(\s*\)|Math\.random\s*\()`, "i");

/** Rules shared by Java and Kotlin. */
export const JVM_RULES: ScanPattern[] = [
  r("jvm.cmd.runtime-exec", "CRITICAL", "CMD_INJECTION", "CWE-78",
    String.raw`\bRuntime\.getRuntime\(\)\.exec\s*\(\s*(?:[A-Za-z_]|"[^"\n]*"\s*\+)|\bProcessBuilder\s*\(\s*"(?:sh|bash|cmd(?:\.exe)?)"\s*,\s*"(?:-c|/[cC])"`),
  r("jvm.deser.object-input", "HIGH", "DESERIALIZATION", "CWE-502", String.raw`\bObjectInputStream\s*\(|\.enableDefaultTyping\s*\(|\bnew\s+XMLDecoder\s*\(`),
  r("jvm.crypto.weak", "HIGH", "WEAK_CRYPTO", "CWE-327",
    String.raw`\b(?:MessageDigest|Cipher|SecretKeyFactory|Mac|KeyGenerator)\.getInstance\s*\(\s*"(?:MD5|MD2|SHA-?1|DES|DESede|RC2|RC4|Blowfish|AES|[A-Za-z0-9]+/ECB[^"]*)"`),
  r("jvm.tls.trust-all", "HIGH", "TLS", "CWE-295",
    String.raw`\b(?:ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|TrustAllStrategy|TrustSelfSignedStrategy)\b|\bHostnameVerifier\b[^\n]{0,60}->\s*true`),
  RANDOM_SECRET,
];

/** Java-only rules. */
export const JAVA_RULES: ScanPattern[] = [
  r("java.sql.concat", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\b(?:execute\w*|prepareStatement|createQuery|createNativeQuery)\s*\(\s*"[^"\n]{0,300}\b${SQL}\b[^"\n]{0,300}"\s*\+`, "i"),
];

/** Kotlin-only rules. */
export const KOTLIN_RULES: ScanPattern[] = [
  r("kt.sql.template", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\b(?:execute\w*|rawQuery|execSQL|createQuery|createNativeQuery|prepareStatement|query)\s*\(\s*"{1,3}[^"\n]{0,300}\b${SQL}\b[^"\n]{0,300}\$\{?\w`, "i"),
];

/** C# rules (cs). */
export const CSHARP_RULES: ScanPattern[] = [
  r("cs.cmd.process-start", "HIGH", "CMD_INJECTION", "CWE-78",
    String.raw`\bProcess\.Start\s*\(\s*(?:"(?:cmd(?:\.exe)?|powershell(?:\.exe)?|/bin/(?:ba)?sh|bash|sh)"\s*,\s*(?:\$@?"|"[^"\n]*"\s*\+|[A-Za-z_])|[a-z_]\w*\s*\))`),
  r("cs.sql.concat", "CRITICAL", "SQL_INJECTION", "CWE-89",
    String.raw`\b(?:new\s+SqlCommand\s*\(|ExecuteSqlRaw\s*\(|FromSqlRaw\s*\(|CommandText\s*=)\s*(?:\$@?"[^"\n]{0,300}\b${SQL}\b[^"\n]{0,300}\{|@?"[^"\n]{0,300}\b${SQL}\b[^"\n]{0,300}"\s*\+)`, "i"),
  r("cs.deser.unsafe", "CRITICAL", "DESERIALIZATION", "CWE-502",
    String.raw`\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|SoapFormatter|LosFormatter|ObjectStateFormatter)\s*\(|\bTypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects|Arrays)\b`),
  r("cs.crypto.weak", "HIGH", "WEAK_CRYPTO", "CWE-327",
    String.raw`\b(?:MD5|SHA1|DES|TripleDES|RC2)\.Create\s*\(|\bnew\s+(?:MD5|SHA1|DES|RC2|TripleDES)(?:CryptoServiceProvider|Managed|Cng)\s*\(|\bCipherMode\.ECB\b`),
  r("cs.tls.disabled", "HIGH", "TLS", "CWE-295",
    String.raw`\bServerCertificate(?:Custom)?ValidationCallback\s*\+?=[^;\n]{0,120}(?:=>\s*true\b|DangerousAcceptAnyServerCertificateValidator)`),
  RANDOM_SECRET,
];

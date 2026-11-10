/**
 * @module security/scan
 * OWASP vulnerability scanner (`harness scan <dir>`, skill `/fuse-security:scan`;
 * NOT a hook). One walk, one read per file: each file is classified by
 * extension (shared table `util/source-languages`) and matched against its
 * language rules plus the language-agnostic secrets. The report keeps the
 * legacy keys byte-compatible and appends `coverage` (and per-finding
 * `id`, `cwe`, `owasp`, `language`).
 * @packageDocumentation
 */
import { extname } from "node:path";
import { CoverageBuilder } from "./scan/coverage";
import { GENERATED_RE, KNOWN_UNSUPPORTED, LEGACY_EXT } from "./scan/constants";
import { readCandidate } from "./scan/filter";
import { detectLanguage, languageOf } from "./scan/languages";
import { resolveScanLimits } from "./scan/limits";
import { scanText } from "./scan/match";
import { allPatterns, patternsFor } from "./scan/patterns";
import type { Finding, ScanReport } from "./scan/types";
import { walkTree } from "./scan/walk";

export type { Coverage, Finding, ScanLimits, ScanReport } from "./scan/types";
export { detectLanguage };

interface Raw { ord: number; seq: number; finding: Finding }

/**
 * Run the OWASP scan over `dir` and return the aggregated {@link ScanReport}.
 * @param dir - directory to scan
 * @param env - environment carrying the optional `FUSE_SCAN_*` limits
 */
export function runSecurityScan(dir: string, env: Record<string, string | undefined> = process.env): ScanReport {
  const limits = resolveScanLimits(env);
  const cov = new CoverageBuilder();
  const order = new Map(allPatterns().map((p, i) => [p.id, i]));
  const raws: Raw[] = [];
  let newFiles = 0;
  let newBytes = 0;
  let seq = 0;
  const language = detectLanguage(dir);
  const legacyExt = LEGACY_EXT[language];
  walkTree(dir, {
    excluded: () => { cov.skipped.excludedDirs++; },
    project: (root, marker) => cov.addProject(root, marker),
    file: (path, name) => {
      const lang = languageOf(name);
      if (!lang) {
        const ext = extname(name).toLowerCase();
        if (GENERATED_RE.test(name)) cov.skipped.generated++;
        else if (KNOWN_UNSUPPORTED.has(ext)) cov.addUnsupported(ext);
        return;
      }
      const legacy = legacyExt !== undefined && name.endsWith(legacyExt);
      if (!legacy && (newFiles >= limits.maxFiles || newBytes >= limits.maxTotalBytes)) { cov.skipped.capped = true; return; }
      const c = readCandidate(path, name, limits, legacy);
      if ("skip" in c) { cov.skipped[c.skip]++; return; }
      if (!legacy) { newFiles++; newBytes += c.bytes; }
      const patterns = patternsFor(lang, legacy);
      cov.addFile(lang, c.bytes, patterns.length);
      const { hits, longLines } = scanText(c.text, patterns, limits.maxLineChars);
      cov.skipped.longLines += longLines;
      seq++;
      for (const { pattern: p, line } of hits) {
        const finding: Finding = {
          severity: p.severity, category: p.category, pattern: p.regex.source, file: path, line, id: p.id, cwe: p.cwe,
          ...(p.owasp ? { owasp: p.owasp } : {}), language: lang,
        };
        raws.push({ ord: order.get(p.id) ?? 0, seq, finding });
      }
    },
  }, legacyExt);
  raws.sort((a, b) => a.ord - b.ord || a.seq - b.seq || a.finding.line - b.finding.line);
  const findings = raws.map((r) => r.finding);
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) { const k = f.severity.toLowerCase(); counts[k] = (counts[k] ?? 0) + 1; }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { language, directory: dir, summary: { ...counts, total }, findings, coverage: cov.finalize(limits) };
}

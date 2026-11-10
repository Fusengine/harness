# `harness scan` — wide-coverage OWASP scanner

One walk, one read per file. Each file is classified by extension (shared table
`src/util/source-languages.ts`) and matched against its language rules plus the
language-agnostic secrets. Config/text files (`.env*`, json, yaml, toml, ini,
properties, xml, plist, gradle, sh, tf, pem, key, `.npmrc`...) are scanned for
secrets only; markdown and lockfiles are not scanned.

## Output (backward compatible)

Legacy keys keep their order and values: `language` (root marker, unchanged),
`directory`, `summary{critical,high,medium,low,total}`, `findings[]{severity,
category,pattern,file,line}`. New keys are only appended: per finding `id, cwe,
owasp?, language`; per report a final `coverage` block (`patternSetVersion`,
`primaryLanguage`, `languages`, `filesScanned`, `patternsApplied`, `totals`,
`projects`, `skipped`, `unsupported`, `limits`).

## No-regression rule

Files the legacy scanner read (only the extension of the ROOT-detected language:
`.js` in a package.json project, `.php`, `.py`, `.swift`) bypass every size,
line, binary, minified and cap rule, and are the ONLY files the 18 legacy rules
run on (other files get the precise new rules only). Legacy rules are never
suppressed by the per-line CWE dedupe. Legacy rules keep their regex, severity and category
(child_process stays CRITICAL, mysql_query stays HIGH). Guarded by
`test/scan-compat.test.ts` (fixtures, 60 random trees, real CLI).

## Exclusions

Gating: only the legacy set (`node_modules vendor .git dist build`) applies to
files the legacy scanner read (the root-detected language's extension: `.js` in
a package.json project, `.php`, `.py`, `.swift`). Widened exclusions are still
entered for those files, so no legacy finding is lost; for every other file
they hide the directory.

Always: `node_modules vendor .git dist build` (legacy) plus VCS/IDE state,
dependency and tool caches, framework build output (`.next .nuxt .svelte-kit
.astro .output coverage __pycache__ .venv Pods .gradle ...`, see
`scan/constants.ts`). Nested: `storage/framework`, `bootstrap/cache`,
`public/build`, `.claude/worktrees`. Conditional (ordinary words): `target`
(Cargo.toml/pom.xml/build.gradle sibling), `bin`/`obj` (csproj/sln sibling),
`out` (package.json sibling), `venv`/`env` (contain `pyvenv.cfg`).

## Limits (env, defaults)

`FUSE_SCAN_MAX_FILE_BYTES` 1 MiB, `FUSE_SCAN_MAX_LINE_CHARS` 4096,
`FUSE_SCAN_MAX_FILES` 50000, `FUSE_SCAN_MAX_TOTAL_BYTES` 256 MiB. They apply
only to files the legacy scanner did not read; hitting a cap sets
`coverage.skipped.capped`. Rule ids are snapshot-tested: changing them requires
bumping `PATTERN_SET_VERSION` (currently `2026.11.2`).

## Secret heuristic

`any.secret.hardcoded` ignores URL values (`scheme://...`) and placeholders
(`example`, `changeme`, `xxx`, `placeholder`, `your_`/`your-`, `redacted`,
`dummy`, `${...}`, `<...>`, `process.env`).

## OWASP labels

CWE to OWASP Top 10:2025 labels were checked against the per-category CWE lists
on owasp.org/Top10/2025; CWEs not listed there (119, 242) carry no label.

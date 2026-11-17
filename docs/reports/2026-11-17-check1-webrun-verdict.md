# Check-1 web.run verdict flake (Publish 0.1.124)

## Symptom
Publish run 43993769096 (tag v0.1.124, `aefa7d5`, Bun 1.4.4): `Check-1: every web.run Write verdict equals its WebSearch twin (.tsx / .ts / .php)` failed.
Expected (WebSearch twin, evaluated second) = `[BLOCKED] Design skill ... design skill not consulted before writing UI`;
received (webrun, evaluated first) = `[BLOCKED] APEX: explore + research required ... (2min TTL)`. Passed on the CI run of main.

## Root cause (proven): a PRODUCT defect exposed by a random test dir
UI-intent gates matched path fragments against the whole ABSOLUTE path, so folders ABOVE the project changed a user's verdict.
- `src/policy/design/skill-gate.ts` `UI_PATH_RE` (`components|ui|styles|page|layout|content|view|feature|section|hero|footer|header|sidebar|nav|modal|dialog`) and `src/policy/shadcn-skill-gate.ts` `SHADCN_PATH_RE` (`components|ui|shadcn|components.json`) were tested on the absolute path. `designGate` runs before the APEX gate (`src/runtime/handle-pre.ts:65`).
- Real hook call (`handleHook`, same input, only the cwd differs), aefa7d5:
  - `.ts` and `.php`: APEX under both `/tmp/aXuiY/proj` and `/tmp/plain/proj` (UI_FILE_RE excludes them from the design gate).
  - `.tsx` (Write and Codex apply_patch): `/tmp/aXuiY/proj` -> `Design skill`; `/tmp/plain/proj` -> `APEX`. Under the first fix attempt (design gate only) the same probe printed `shadcn/ui skill` for aXuiY: a second gate with the same flaw.
- The Check-1 test created each twin's project dir with `mkdtempSync("fh-cxweb-wv-XXXXXX")`; a lowercase fragment (e.g. `uiHOyU`) in one suffix flipped that twin.
- Not a TTL / clock / shared-state / Bun-version / HOME issue: the probe injects `now`, state is keyed by cwd hash.

Measured (HOME isolated on the command line): 20 000 mkdtemp samples -> p = 0.19 % per call, 12 `.tsx` calls per run -> ~2.25 % per run predicted; old test, 150 isolated runs on aefa7d5: 3 failed (2.0 %).

## Fix
Product (no new block: no pattern contains `/`, so any match in the project-relative path is also a match in the absolute one; exemption regexes stay on the absolute path; outside-root, non-absolute root or non-absolute file falls back to the old absolute check):
- `src/policy/project-relative.ts` (new): `projectRelativePath(file, root)`.
- `src/policy/design/skill-gate.ts`: `isUiWrite` / `uiDesignSkillGate` take optional `projectRoot`.
- `src/policy/shadcn-skill-gate.ts`: `isShadcnWrite` / `shadcnSkillGate` take optional `projectRoot`.
- `src/runtime/design.ts`, `src/runtime/gate.ts`: pass `resolveProjectDir(cwd)` (CLAUDE_PROJECT_DIR wins over cwd, same rule as the state dir).
Test (kept as defence in depth, assertions of Check-1 unchanged):
- `test/helpers/web-write-verdict.ts`: `writeVerdict` extracted; project dir `fh-cxweb-wv-<pid>-<n>` (digits only).
- `test/codex-native-web-doc-credit.test.ts`: imports the helper.
- `test/webrun-verdict-cwd-name.test.ts` (new, env-isolated from CLAUDE_PROJECT_DIR): ancestor `aXuiY` / `nav-ui-tools` never changes the verdict (.ts/.tsx/.php); in-project `components|ui|pages` still triggers the design gate; unit tests of isUiWrite / isShadcnWrite; helper invariants.

## Proof
- RED on aefa7d5 src (new tests, src stashed): 3 fail (ancestor-verdict, isUiWrite, isShadcnWrite); GREEN with fix: 53 pass / 0 fail on the 6 related files.
- Check-1 + new file: 30/30 isolated, 30/30 under 2 busy loops; also green with `CLAUDE_PROJECT_DIR=/nonexistent/x`.
- `bunx tsc --noEmit`: 0 errors.
- Full suite: see final message.

## Known residual (not fixed on purpose, owner decision)
`SKIP_DIRS` (`src/policy/trivial-edits.ts:15`, `/(node_modules|vendor|dist|build|\.next|DerivedData)/`) is an unanchored substring test on the absolute path in `src/runtime/gate-apex.ts:77`: any ancestor such as `~/distributed-sys/` or `~/rebuild/` makes the whole APEX gate (freshness, Check 1/2, SOLID refs) return allow. Medium severity (protected-path guard still runs first). Fixing it turns allows into blocks, so it needs the owner's go.
Cosmetic: `designPassNotice` (`src/policy/design/gates.ts:70`) still calls `isUiWrite` without a root; it only prints a pass line.

## Suggestions
- Suggestion: anchor SKIP_DIRS on project-relative path segments -> gain: no ancestor folder name can disable APEX (needs owner go: new blocks).
- Suggestion: Publish uses `bun-version: latest` (1.4.4) while CI pins 1.4.0 -> gain: the tag build tests what CI tested.

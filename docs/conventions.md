# Conventions Module

The conventions module (`src/policy/conventions/`) enforces the canonical project structure across every supported language — with masked-content detection (declarations inside comments, strings, template literals, or heredocs never match), per-language batteries, and a single rollout flag.

## Canonical structure

```
modules/<feature>/
├── components/        ← reusable components of the module (above src/)
└── src/
    ├── interfaces/    ← interface Foo { } contracts
    ├── types/         ← exported type aliases
    ├── hooks/         ← custom use* hooks
    ├── stores/        ← *.store.ts (Zustand, Pinia)
    └── query/         ← TanStack Query definitions
(+ modules/cores/… for cross-feature code)
```

Framework scoping: stores are detected by in-file signature (real `zustand`/`pinia` import, or the v5 curried `create<T>()(`), query rules by the manifest cap (`@tanstack/*-query` in the nearest manifest), components/hooks rules by path + content. A rule never fires outside its framework family.

Gate selection is manifest-first (H1, `src/policy/js-gate-route.ts`): a project whose nearest manifest declares `next` routes every JS/TS file to the Next.js gate (the `'use client'` rule therefore applies even to marker-less client components — content-based routing let them land and crash at runtime); `react`/TanStack Start projects route to the react gate; projects with no JS-framework capability (no manifest, backend, vue) keep the legacy content-marker routing, byte-identical. Consequence: the legacy react hook-location rule does not apply inside a next-manifest project.

## Rule matrix

Legacy rules always deny (byte-identical verdicts). New rules deny by default and degrade to a non-blocking `inform` only under `FUSE_CONVENTIONS_MODE=advisory`.

| Rule | Scope | Mode | Message |
| --- | --- | --- | --- |
| File-size ceiling | all code files | legacy deny | `BLOCKED: '<file>' has N lines (max: M)` |
| Interface separation | per language, category paths | legacy deny | `SOLID VIOLATION: Interface in handler file. Move to internal/interfaces/` (etc.) |
| React hook location | react | legacy deny | `Custom hook defined outside hooks/ directory. Move to hooks/.` |
| Type alias in component | ts/vue | new | `Type alias in component file. Move to modules/[feature]/src/types/` |
| Hook outside hooks/ (widened) | react/nextjs/tanstack | new | `Custom hook defined outside hooks/ directory. Move to modules/[feature]/src/hooks/.` |
| Hook file budget | `use*.ts` in hooks/ | new | `Hook file has N lines (limit: M). Extract smaller hooks.` |
| Store outside stores/ | zustand/pinia | new | `Store defined outside stores/ directory. Move to modules/[feature]/src/stores/.` |
| Store file budget | `*.store.ts` in stores/ | new | `Store file has N lines (limit: M).` |
| Query hook in component/page | TanStack Query, cap-gated | new | `Query hook defined outside query/ directory. Move to modules/[feature]/src/query/.` |
| Misplaced component | `.tsx/.vue` in `src/hooks|stores|query|interfaces|types/` | new | `Component does not belong in <dir>. Move to modules/[feature]/components/.` |
| Extended interface syntaxes | swift `public protocol`, kotlin `sealed`/`fun interface`, go unexported | new | same destinations as the legacy rules |
| `routeTree.gen.ts` | tanstack-start | always hard deny | generated file — never edited |

Exemptions: store- and query-definition files are not hooks (the hook rule skips them) — but only when the signature is validated (real `zustand`/`pinia` import or curried `create<T>()(`) and, for query, the `@tanstack/*-query` dependency exists in the nearest manifest. Without the cap, the legacy hook rule fires unchanged.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `FUSE_SOLID_MAX_LINES` | `100` | Pilots everything: global ceiling, special files `base + 50` (Next `page/layout/loading/error`, Swift `View/Screen`), `hookBudget` (ratio 0.3 → 30), `storeBudget` (ratio 0.4 → 40) |
| `FUSE_CONVENTIONS_MODE` | `deny` | `advisory` = opt-out observation mode (`inform`); any other/absent value blocks |
| `FUSE_ENFORCE_TTL_SEC` | `120` | APEX freshness window (see `src/config/ttl.ts`) |
| `FUSE_HOOK_STDIN_MAX_BYTES` | `16777216` (16 MiB) | Hook stdin cap: bounded read; oversized payload on a blockable event is denied uninspected (fail-closed), observation-only events stay neutral |
| `FUSE_CARTO_FULL_READ_MAX_BYTES` | `1048576` (1 MiB) | Cartographer description read: files up to this size are read whole, larger ones only their first `cap` bytes cut at the last newline (binary-looking head, or a `.md` frontmatter not closed in the prefix → no description); the merge step also treats an existing `index.md` / `.enriched.json` that is not a regular file or exceeds the cap as absent; absent/invalid → default (see `src/runtime/lifecycle/cartographer/bounded-read.ts`) |

## Special cases and voluntary gaps

- `routeTree.gen.ts` is a generated artifact: editing it is always blocked.
- Rust `impl<T> Trait for X` remains a known false negative (legacy parity).
- Pure-template Vue SFCs (no `<script>` block) declare nothing detectable.
- The store/query exemption is signature+cap-gated (see matrix note).
- `SELF_GATE_EXCLUDE_RE` exempts the detector sources themselves from pattern heuristics; any new detector file must be added there (lock test: `test/self-gate-exclude.test.ts`).

See `ROADMAP.md` — “Écarts volontaires” — for the full, dated list of intentional deviations from the original Python parity.

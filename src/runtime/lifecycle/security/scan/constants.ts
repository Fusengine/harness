/**
 * @module security/scan/constants
 * Documented scanner constants: pattern-set version, directory exclusions and
 * file-name skip rules. Changing the rule ids requires bumping the version.
 * @packageDocumentation
 */

/** Bump whenever a rule id is added, removed or renamed (snapshot-tested). */
export const PATTERN_SET_VERSION = "2026.11.2";

/** Directory names excluded by the pre-coverage scanner (kept). */
export const LEGACY_EXCLUDE_DIRS: readonly string[] = ["node_modules", "vendor", ".git", "dist", "build"];

/**
 * Directory names excluded unconditionally: VCS/IDE state, dependency caches,
 * framework build output and tool caches (third-party or generated code).
 */
export const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ...LEGACY_EXCLUDE_DIRS, ".hg", ".svn", ".idea", ".vscode", ".vs", "bower_components", "jspm_packages",
  ".yarn", ".pnpm-store", ".npm", ".next", ".nuxt", ".svelte-kit", ".astro", ".output", ".turbo", ".cache",
  ".parcel-cache", ".vite", ".vercel", ".netlify", ".angular", ".expo", "coverage", "storybook-static",
  "__pycache__", ".venv", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages",
  ".eggs", ".bundle", ".gradle", "Pods", "Carthage", "DerivedData", ".build", ".swiftpm", ".dart_tool",
  ".terraform", ".serverless", ".cartographer", ".worktrees",
]);

/** Nested directory paths excluded (suffix match on the relative path). */
export const EXCLUDE_PAIRS: readonly string[] = [
  ".claude/worktrees", "storage/framework", "bootstrap/cache", "public/build",
];

/**
 * Ordinary-word directory names excluded only when an ecosystem marker proves
 * the meaning: name -> sibling marker predicate (file names of the parent).
 */
export const CONDITIONAL_DIRS: Readonly<Record<string, (siblings: readonly string[]) => boolean>> = {
  target: (s) => s.some((n) => ["Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"].includes(n)),
  bin: (s) => s.some((n) => /\.(?:cs|fs|vb)proj$|\.sln$/.test(n)),
  obj: (s) => s.some((n) => /\.(?:cs|fs|vb)proj$|\.sln$/.test(n)),
  out: (s) => s.includes("package.json"),
};

/** Directory names excluded when they contain `pyvenv.cfg` (a Python venv). */
export const VENV_DIRS: ReadonlySet<string> = new Set(["venv", "env"]);

/** Extension the legacy scanner read per root-detected language (others read nothing). */
export const LEGACY_EXT: Readonly<Record<string, string | undefined>> = {
  javascript: ".js", php: ".php", python: ".py", swift: ".swift",
};

/** Lockfiles skipped by name (integrity hashes look like secrets / weak hashes). */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "Cargo.lock",
  "go.sum", "Gemfile.lock", "poetry.lock", "Podfile.lock", "npm-shrinkwrap.json",
]);

/** Generated files skipped by name: source maps, snapshots, type declarations, env templates. */
export const GENERATED_RE: RegExp = /\.(?:map|snap)$|\.d\.[cm]?ts$|^\.env\..*(?:example|sample|template)$/i;

/** Minified/bundled file names (skipped only when the legacy scanner did not read them). */
export const MINIFIED_NAME_RE: RegExp = /\.(?:min|bundle|chunk)\./i;

/** Marker files recorded as projects (informational monorepo map). */
export const PROJECT_MARKERS: readonly string[] = [
  "package.json", "composer.json", "requirements.txt", "pyproject.toml", "Package.swift", "go.mod",
  "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "deno.json",
];

/** Known code extensions with no rule table: surfaced in `coverage.unsupported`. */
export const KNOWN_UNSUPPORTED: ReadonlySet<string> = new Set([
  ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".dart", ".lua", ".scala", ".ex", ".exs", ".pl", ".r",
  ".sol", ".zig", ".clj", ".groovy", ".ps1", ".vb", ".fs", ".erl", ".hs", ".ml", ".jl",
]);

/**
 * Argument parsing + harness resolution for `harness prd <cmd>`. Resolves
 * `--root` (default `cwd`) and `--id`/`homeSeg` (default: the sole
 * `HOME_DIR` (`config/dotenv.ts`) segment under which
 * `<root>/<seg>/apex/prd.json` exists — ambiguous or absent is a caller
 * error, never guessed).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, loadDotenv } from "../../config/dotenv";
import { harnessHomeSegment } from "../../policy/apex-target";
import type { HarnessId } from "../../detect/interfaces/types";

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--id", "--root", "--task"]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--json"]);

/** Resolved `--root`/`--id` pair for a `prd` sub-command. */
export interface PrdResolved {
  root: string;
  homeSeg: string;
  id: HarnessId;
}

/** Options for {@link resolvePrdArgs}. */
export interface PrdResolveOptions {
  /**
   * `harness prd init` only: with no router and no `--id`, fall back to the
   * sole existing home segment (`<root>/.claude`, ...). Default `false`, so
   * `status`/`validate`/`compact` resolve exactly as before.
   */
  allowNoRouter?: boolean;
}

/** Result of {@link resolvePrdArgs}: resolved args, or a usage error (exit 2). */
export type PrdResolveResult = { ok: true; value: PrdResolved } | { ok: false; message: string };

/** Read `--<name> <value>` from argv, or `undefined` when absent. */
export function readFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

/** True when `--json` is present in argv. */
export function hasJsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

/** Non-flag tokens in argv, skipping known flags and their values. */
export function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (VALUE_FLAGS.has(tok)) { i++; continue; }
    if (BOOLEAN_FLAGS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

/** `init` fallback: the one `HOME_DIR` segment whose directory exists under `root`; zero or several is a usage error. */
function soleHomeSegment(root: string): PrdResolveResult {
  const present = (Object.entries(HOME_DIR) as Array<[HarnessId, string]>).filter(([, seg]) => existsSync(join(root, seg)));
  if (present.length === 1) {
    const [id, seg] = present[0] as [HarnessId, string];
    return { ok: true, value: { root, homeSeg: seg, id } };
  }
  const found = present.length === 0 ? "no harness home directory" : `several harness home directories (${present.map(([id]) => id).join(", ")})`;
  return { ok: false, message: `${found} under ${root} — pass --id <harness>` };
}

/**
 * Resolve `{root, homeSeg, id}` for a `prd` sub-command. `--id` wins
 * outright; otherwise auto-detects the sole `HOME_DIR` segment under which
 * `<root>/<seg>/apex/prd.json` exists.
 */
export function resolvePrdArgs(argv: string[], cwd: string, opts: PrdResolveOptions = {}): PrdResolveResult {
  const root = readFlag(argv, "--root") ?? cwd;
  const idFlag = readFlag(argv, "--id");
  if (idFlag) {
    return { ok: true, value: { root, homeSeg: harnessHomeSegment(idFlag), id: idFlag as HarnessId } };
  }

  const matches: Array<{ id: HarnessId; seg: string }> = [];
  for (const [id, seg] of Object.entries(HOME_DIR) as Array<[HarnessId, string]>) {
    if (existsSync(join(root, seg, "apex", "prd.json"))) matches.push({ id, seg });
  }
  if (matches.length === 0 && opts.allowNoRouter) return soleHomeSegment(root);
  if (matches.length === 0) {
    return { ok: false, message: `no PRD router found under ${root}/<home>/apex/prd.json — pass --id <harness>` };
  }
  if (matches.length > 1) {
    return { ok: false, message: `ambiguous harness: PRD routers found for ${matches.map((m) => m.id).join(", ")} — pass --id` };
  }
  const only = matches[0] as { id: HarnessId; seg: string };
  return { ok: true, value: { root, homeSeg: only.seg, id: only.id } };
}

/**
 * Shared first step of every `prd` sub-command: {@link resolvePrdArgs}, then
 * (on success) `loadDotenv` the resolved harness's home `.env` + `<root>/.env`
 * as a side effect on `env` — same env-loading contract as the `hook` branch
 * (`bin.ts`'s `loadDotenv(id)` call).
 */
export function resolveAndLoadEnv(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, opts: PrdResolveOptions = {}): PrdResolveResult {
  const resolved = resolvePrdArgs(argv, cwd, opts);
  if (resolved.ok) loadDotenv(resolved.value.id, env, homedir(), resolved.value.root);
  return resolved;
}

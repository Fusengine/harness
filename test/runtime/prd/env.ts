/**
 * @module test/runtime/prd/env
 * Shared temp-HOME/temp-cwd isolation for the Lot B runtime PRD tests — never
 * the real `~/.fuse-harness` (CLAUDE.md hard stop). `createPrdEnv`'s `root`
 * doubles as `HOME`, so every track file this module's functions read/write
 * lands under `<root>/.fuse-harness/state/...`, inside the disposable tmp
 * tree `cleanup()` removes.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir, trackFile } from "../../../src/runtime/paths";
import { prdAgentReportPath, prdRouterPath, prdTaskPath } from "../../../src/policy/prd";
import { createPrdEnv, type PrdEnv } from "../../helpers/prd-env";

/**
 * Rewrites the fixture task-PRD so BOTH agents' sole sub-task is `validated`
 * — `backend-expert`'s own report already says `done` for `jwt-validation`
 * (no violation there), but `backend-expert-2` has no report at all, so this
 * always yields exactly ONE genuine cross-check violation. Shared by the
 * PostToolUse and lead-Stop gate tests (B2/B5), which both need a REAL
 * violation on disk, not a hand-rolled one that could silently drift from
 * what `crossCheckTask` actually checks.
 */
export function seedCrossCheckViolation(root: string, homeSeg: string): void {
  writeFileSync(prdTaskPath(root, homeSeg, "prd/auth-refactor-prd.json"), JSON.stringify({
    "backend-expert": { files: ["src/auth/login.ts"], "sub-tasks": { "jwt-validation": { status: "validated", "validated-at": "t0" } } },
    "backend-expert-2": { files: ["src/auth/session.ts"], "sub-tasks": { "session-store": { status: "validated", "validated-at": "t0" } } },
  }));
}

/**
 * Workaround for a cross-lot fixture bug (reported to the coordinator, not
 * fixed here — `test/helpers/prd-env.ts` is Lot D's exclusive file):
 * `materializePrdFixtures` copies the router fixture to `<apex>/router.json`,
 * but the actual contract (`prd-paths.ts#prdRouterPath`, design doc §0) reads
 * it from `<apex>/prd.json`. Without this rename, `isPrdEnabled` never sees
 * the router as present and every PRD test using this fixture set would be a
 * false negative (module reads as permanently disabled).
 */
function fixupRouterFilename(root: string, homeSeg: string): void {
  const wrongPath = join(root, homeSeg, "apex", "router.json");
  if (existsSync(wrongPath)) renameSync(wrongPath, prdRouterPath(root, homeSeg));
}

/**
 * The shared fixture ships `backend-expert`'s report COMPLETE on disk, i.e. a
 * CLOSED slot (a fresh agent may not claim it). Tests that need a fresh agent
 * to claim that exact slot reopen it first by removing the report.
 */
export function reopenFixtureSlot(root: string, homeSeg: string, agent = "backend-expert"): void {
  rmSync(prdAgentReportPath(root, homeSeg, agent), { force: true });
}

/** One isolated PRD test environment: populated project root, temp HOME, and its session track path. */
export interface PrdTestEnv extends PrdEnv {
  sessionId: string;
  trackFilePath: string;
  /** Restores `process.env.HOME` and removes the tmp tree. */
  restore: () => void;
}

/**
 * Materializes the PRD fixtures under a fresh tmp project, pins `HOME` to
 * that SAME root for the duration (restored by `restore()`), and precomputes
 * this env's session track path.
 * @param homeSeg - Home-dir segment to materialize under (default `.claude`).
 * @param sessionId - Session id for the track file (default `"s1"`).
 */
export function setupPrdEnv(homeSeg = ".claude", sessionId = "s1"): PrdTestEnv {
  const env = createPrdEnv(homeSeg);
  fixupRouterFilename(env.root, env.homeSeg);
  const prevHome = process.env.HOME;
  process.env.HOME = env.root;
  const trackFilePath = trackFile(sessionId, defaultStateDir(env.root));
  return {
    ...env,
    sessionId,
    trackFilePath,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      env.cleanup();
    },
  };
}

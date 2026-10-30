/**
 * @module motion/store-failure
 * Scoping of a Motion store/keys failure: it blocks Motion-scoped calls only (inside a `.motion/`
 * project, or touching the Motion store/keys); every other call proceeds as if Motion were absent.
 */
import { homedir } from "node:os";
import { protectedMotionDirectory } from "../../policy/motion/guard-scope";
import { motionLeftoverKeyNotice } from "../../policy/motion/store";
import type { MotionStoreError } from "../../policy/motion/trust";
import type { NormalizedEvent } from "../normalize";

/**
 * Whether a store failure concerns Motion work.
 * @param error - The store failure (key-directory errors are always Motion work).
 * @param inProject - A Motion project was resolved for this call.
 * @param event - Normalized event (command / file path are matched against the store/project markers).
 * @param cwd - Working directory of the call.
 * @param home - OS home.
 */
export function storeFailureIsMotionScoped(error: MotionStoreError, inProject: boolean, event: NormalizedEvent, cwd: string, home: string = homedir()): boolean {
  if (error.scoped || inProject) return true;
  if (/video-motion|\.motion/.test([event.filePath, event.command].join(" "))) return true;
  try { return protectedMotionDirectory(cwd, home); } catch { return true; }
}

/** One-line leftover-key notice for Motion context; empty when there is none or the store is unusable. */
export function leftoverKeyContext(home: string): string {
  try { return motionLeftoverKeyNotice(home) ?? ""; } catch { return ""; }
}

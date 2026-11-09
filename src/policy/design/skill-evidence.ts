/**
 * @module design/skill-evidence
 * IO side of the UI design-skill gate: read the verified session track and
 * derive {@link DesignEvidence} (read references + doc-consulted) for
 * {@link uiDesignSkillGate}. Kept separate from the pure gate logic (SRP).
 * @packageDocumentation
 */
import type { SessionTrack } from "../../tracking/session-state";
import { trackJournalEnabled } from "../../tracking/store";
import { readTrackSync } from "../../tracking/track-compact";
import { trackFile } from "../../runtime/paths";
import { projectStateDir } from "../../runtime/project-state-dir";
import { isDocConsulted } from "../../freshness/doc-helpers";
import type { DesignEvidence } from "./skill-gate";

/**
 * Read the verified session track (snapshot ⊕ journal) and derive
 * {@link DesignEvidence}. Fail-closed on a missing/corrupt/tampered track (no
 * evidence → the gate blocks).
 * @param sessionId - the Claude session id.
 * @param cwd - the project root (selects the per-project state dir).
 * @param baseDir - override the track base dir (tests); defaults to the project state dir.
 */
export function collectDesignEvidence(sessionId: string, cwd: string, baseDir: string = projectStateDir(cwd)): DesignEvidence {
  let track: SessionTrack | null = null;
  try {
    track = readTrackSync(trackFile(sessionId, baseDir), trackJournalEnabled());
  } catch {
    track = null;
  }
  return {
    refsRead: track?.refsRead ?? [],
    docConsulted: track ? isDocConsulted(track.authorizations, sessionId) : false,
  };
}

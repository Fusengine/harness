/** Types for the PRD router guard (`../prd-router-guard.ts`). */
import type { PrdIdentity, PrdRouterSnapshot } from "../../../policy/prd";
import type { NormalizedEvent } from "../../normalize";

/** What a write leaves at the target: its text, a deletion, or "cannot be determined with certainty". */
export type PostWrite = { state: "text"; text: string } | { state: "deleted" } | { state: "unknown" };

/** Inputs of `derivePostWrite`. */
export interface PostWriteInput {
  event: NormalizedEvent;
  /** Raw apply_patch text (`tool_input.command`, else the top-level `command`); "" for other tools. */
  patch: string;
  /** True when a path (any spelling: relative, `./`, absolute, `//`, symlinked parent) is the target file. */
  isTarget: (path: string) => boolean;
  /** The target's current text, `null` when absent/unreadable. */
  current: string | null;
}

/** Verdict for a write while the router is broken: `allow` (repair authorized) or a `deny` reason. */
export type BrokenRouterVerdict = { allow: true } | { allow: false; reason: string };

/** Inputs of `brokenRouterVerdict`. */
export interface BrokenRouterInput {
  snapshot: PrdRouterSnapshot;
  event: NormalizedEvent;
  /** Raw apply_patch text, see {@link PostWriteInput.patch}. */
  patch: string;
  /** Canonical candidate file paths of the event (non-empty). */
  files: string[];
  root: string;
  homeSeg: string;
  identity: PrdIdentity;
}

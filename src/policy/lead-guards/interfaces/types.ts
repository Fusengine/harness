/** Verdict of the outcome-only classifier on one final assistant message. */
export interface OutcomeVerdict {
  /** True when the message carries neither an outcome nor an owner action. */
  statusOnly: boolean;
  /** Names of the markers that matched (empty exactly when `statusOnly`). */
  markers: string[];
  /** True when the message is status-only AND within the relay length bounds: the only case the Stop guard blocks. */
  relayLike: boolean;
}

/** Verdict of the scope-traceability check on one brief. */
export interface ScopeVerdict {
  /** True when the brief may be dispatched. */
  ok: boolean;
  /** One-line instruction for the lead when `ok` is false. */
  reason: string;
}

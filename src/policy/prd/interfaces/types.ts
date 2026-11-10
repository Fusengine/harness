/**
 * Shared shapes for the PRD (task/agent ownership coordination) module. Pure
 * types only — no runtime code, no fs. Mirrors the JSON contract at
 * `<root>/<homeSeg>/apex/prd.json` and `<root>/<homeSeg>/apex/prd/**`.
 *
 * FROZEN CONTRACT: this file is imported by both Lot B (runtime wiring) and
 * Lot C (CLI). Do not rename or remove an export without flagging it to the
 * other lots first.
 */

/** Lifecycle status of a task in the router (`prd.json`). */
export type PrdRouterStatus = "assigned" | "in-progress" | "validated";

/** One router entry: which task-PRD file backs a task, and its status. */
export interface PrdRouterEntry {
  prd: string;
  status: PrdRouterStatus;
  "validated-at"?: string;
}

/** The router file itself (`prd.json`), keyed by task name. */
export type PrdRouter = Record<string, PrdRouterEntry>;

/** Lifecycle status of one sub-task inside a task-PRD's agent entry. */
export type PrdSubStatus = "assigned" | "validated";

/** One sub-task's status inside a task-PRD's (expanded) agent entry. */
export interface PrdSubTask {
  status: PrdSubStatus;
  "validated-at"?: string;
}

/** Pre-compaction shape of one agent's slice of a task-PRD. */
export interface PrdAgentEntryExpanded {
  files: string[];
  "sub-tasks": Record<string, PrdSubTask>;
}

/** Post-compaction shape of one agent's slice of a task-PRD (all sub-tasks validated). */
export interface PrdAgentEntryCompacted {
  status: "validated";
  files: string[];
  "validated-at": string;
}

/** One agent's slice of a task-PRD, expanded or compacted. */
export type PrdTaskAgentEntry = PrdAgentEntryExpanded | PrdAgentEntryCompacted;

/** A task-PRD file (`prd/<task>-prd.json`), keyed by agent name. */
export type PrdTaskFile = Record<string, PrdTaskAgentEntry>;

/** One sub-task's completion report inside an agent's own report file. */
export interface PrdAgentSubEntry {
  status: "done";
  modified: string[];
  unchanged: string[];
  "done-at"?: string;
}

/** An agent's own report file (`prd/agents/<agent>-prd.json`), keyed by task then sub-task. */
export type PrdAgentReportFile = Record<string, Record<string, PrdAgentSubEntry>>;

/** Resolved identity of the current tool-use, for the ownership check. */
export interface PrdIdentity {
  agentId?: string;
  agentType?: string;
  /**
   * true = structurally proven lead (Claude/Codex: no agent_id/agent_type on
   * the event); false = structurally proven sub-agent; "unknown" = harness
   * can't tell (Cursor/Kimi — see design doc Risks §1/§2).
   */
  lead: boolean | "unknown";
}

/** PreToolUse ownership verdict for one in-scope PRD write. */
export type PrdOwnershipVerdict =
  | { allow: true; bind?: { agentId: string; name: string } }
  | { allow: false; reason: string }
  | { allow: "advisory" };

/** One cross-check mismatch between a task-PRD's assignment and an agent's own report. */
export interface PrdCrossCheckViolation {
  task: string;
  agent: string;
  sub: string;
  reason: string;
}

/** One sub-agent's rendered slice of a task-PRD, for the SubagentStart injection. */
export interface PrdSubagentSlice {
  task: string;
  agent: string;
  subTasks: string[];
  files: string[];
}

/** Classification of an in-scope PRD path (`isPrdScopedPath`/`classifyPrdPath`). */
export type PrdPathKind =
  | { kind: "router" }
  | { kind: "task"; task: string }
  | { kind: "agentReport"; agent: string }
  | { kind: "docs"; task: string }
  | { kind: "other" };

/** Four-way outcome of reading/classifying the router: absent, unparsable JSON, parsable but off-schema, or valid. */
export type PrdRouterState =
  | { state: "absent" }
  | { state: "syntax"; error: string }
  | { state: "schema"; problems: string[] }
  | { state: "ok"; router: PrdRouter };

/** The router file's raw text (`null` when absent or unreadable) together with its classified state. */
export interface PrdRouterSnapshot {
  text: string | null;
  state: PrdRouterState;
}

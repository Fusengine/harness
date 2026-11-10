/** Barrel for `src/policy/prd/**` — the public surface Lot B and Lot C import from. */
export type {
  PrdAgentEntryCompacted, PrdAgentEntryExpanded, PrdAgentReportFile, PrdAgentSubEntry,
  PrdCrossCheckViolation, PrdIdentity, PrdOwnershipVerdict, PrdPathKind, PrdRouter,
  PrdRouterEntry, PrdRouterSnapshot, PrdRouterState, PrdRouterStatus, PrdSubagentSlice, PrdSubStatus, PrdSubTask, PrdTaskAgentEntry,
  PrdTaskFile,
} from "./interfaces/types";

export {
  classifyPrdPath, isPrdScopedPath, prdAgentReportPath, prdDir, prdDocsPath, prdRouterPath,
  prdTaskPath,
} from "./prd-paths";

export {
  filesOf, isCompacted, parseAgentReportFile, parseRouter, parseTaskFile, subTasksOf,
  validateTaskFileInvariant, withRouterStatus, withSubTaskValidated,
} from "./prd-schema";

export {
  candidateAgentNames, evaluateWriteOwnership, matchesAgentName, resolveOwnerBinding,
} from "./prd-ownership";

export {
  crossCheckRouter, crossCheckTask, hasAnyViolations, incompleteSubTasks,
} from "./prd-crosscheck";

export { canPromoteRouterEntry, compactAgentEntry, compactTaskFile } from "./prd-compact";

export { agentSlice, agentSlices, joinContextResponses, renderAgentSliceMarkdown } from "./prd-context";

export {
  readAgentReport, readAgentReportSync, readAllTaskFiles, readRouter, readRouterSnapshotSync,
  readRouterState, readRouterSync, readTaskFile, readTaskFileSync, writeAgentReport, writeRouter,
  writeTaskFile,
} from "./prd-io";

export { classifyRouterText, describeRouterState, routerProblems } from "./prd-router-state";

export { isPrdEnabled, isPrdFlagSet, prdProjectRoot, routerExistsSync } from "./prd-enabled";

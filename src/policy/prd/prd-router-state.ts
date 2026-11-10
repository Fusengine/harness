/**
 * Pure classification of router text into {@link PrdRouterState}, plus the
 * human-readable diagnostics shared by the PreToolUse gate and the CLI. No fs.
 * `routerProblems` mirrors `parseRouter`'s rules (same status list, same
 * shape checks) but reports WHICH field is wrong instead of collapsing to
 * `null`; `classifyRouterText` always agrees with `parseRouter` on ok vs not.
 */
import { ROUTER_STATUSES, parseRouter } from "./prd-schema";
import type { PrdRouterState } from "./interfaces/types";

const MAX_LISTED_PROBLEMS = 5;

function entryProblems(task: string, v: unknown): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${task}: must be an object`];
  const e = v as Record<string, unknown>;
  const out: string[] = [];
  if (typeof e.prd !== "string") out.push(`${task}.prd: must be a string`);
  if (typeof e.status !== "string") out.push(`${task}.status: must be a string`);
  else if (!(ROUTER_STATUSES as readonly string[]).includes(e.status)) {
    out.push(`${task}.status: "${e.status}" is not one of ${ROUTER_STATUSES.join("|")}`);
  }
  if (e["validated-at"] !== undefined && typeof e["validated-at"] !== "string") out.push(`${task}.validated-at: must be a string`);
  return out;
}

/** Field-level reasons `raw` is not a valid router (empty when it is valid). */
export function routerProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["router must be a JSON object keyed by task name"];
  return Object.entries(raw).flatMap(([task, v]) => entryProblems(task, v));
}

/** Classifies router file text: unparsable -> `syntax` (with the parse error), off-schema -> `schema` (with problems), else `ok`. */
export function classifyRouterText(text: string): PrdRouterState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { state: "syntax", error: err instanceof Error ? err.message : String(err) };
  }
  const router = parseRouter(raw);
  if (router) return { state: "ok", router };
  const problems = routerProblems(raw);
  return { state: "schema", problems: problems.length > 0 ? problems : ["router does not match the PRD router schema"] };
}

/** One-line diagnostic for a non-ok state, naming `path` ("" for `ok`). */
export function describeRouterState(state: PrdRouterState, path: string): string {
  switch (state.state) {
    case "absent":
      return `no PRD router at ${path}`;
    case "syntax":
      return `PRD router is malformed JSON (syntax error: ${state.error}) — fix ${path}`;
    case "schema": {
      const shown = state.problems.slice(0, MAX_LISTED_PROBLEMS).join("; ");
      const more = state.problems.length > MAX_LISTED_PROBLEMS ? ` (+${state.problems.length - MAX_LISTED_PROBLEMS} more)` : "";
      return `PRD router schema invalid: ${shown}${more} — fix ${path}`;
    }
    case "ok":
      return "";
  }
}

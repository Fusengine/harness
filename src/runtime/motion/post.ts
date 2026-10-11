import { homedir } from "node:os";
import type { MotionCall, MotionProject } from "../../policy/interfaces/motion";
import { motionContext } from "./reply";
import { budgetLine, budgetViolation, closeRender, findReservation, loadBudget, releaseRender } from "../../policy/motion/budget";
import { commandMotionProject } from "../../policy/motion/project-command";
import type { HandleOptions } from "../handle-types";

/**
 * Settle a native terminal event against its exact in-flight reservation.
 * Success counts once; failure releases without counting; duplicates yield "".
 * @param id - Harness id.
 * @param call - Host call reduced to the Claude-shaped view.
 * @param opts - Handler options.
 */
export function motionPost(id: string, call: MotionCall, opts: HandleOptions, resolvedProject?: MotionProject | null): string {
  const { event } = call;
  if (!event.toolUseId) return "";
  const home = opts.home ?? homedir();
  const project = resolvedProject === undefined ? commandMotionProject(event.command, opts.cwd, home) : resolvedProject;
  if (!project) return "";
  if (budgetViolation(project.root, home)) throw new Error("Motion budget is corrupt; terminal settlement was not recorded.");
  const start = findReservation(loadBudget(project.root, home), event.toolUseId);
  // A terminal callback is authoritative only for its matching reservation (fresh
  // or TTL-expired retained for late settlement); duplicates are no-ops.
  if (!start) return "";
  const budget = call.kind === "failure" ? releaseRender(project.root, event.toolUseId, home) : closeRender(project.root, event.toolUseId, start.stage, opts.now, home);
  return motionContext(id, call.respondAs, "Motion render", budgetLine(budget));
}

import type { Prompt } from "../../prompt/types";
import type { Guard, GuardContext } from "./context";
import { securityGuard } from "./security";
import { protectedPathGuard } from "./protected-path";
import { bashWriteGuard } from "./bash-write";
import { interfaceSeparationGuard } from "./interface-separation";
import { installGuard } from "./install";
import { gitFlowGuard } from "./git-flow";
import { opaqueShellGuard } from "./opaque-shell";
import { confirmRelayGuard } from "./confirm-relay";

export * from "./context";
export * from "./git-flow";
export * from "./security";
export * from "./protected-path";
export * from "./bash-write";
export * from "./interface-separation";
export * from "./install";

/** Ordered guard chain: git-flow blocks (an ask must never hide them), critical/security + protected, then writes/installs. */
export const GUARDS: ReadonlyArray<Guard> = [
  gitFlowGuard,
  confirmRelayGuard,
  securityGuard,
  protectedPathGuard,
  bashWriteGuard,
  interfaceSeparationGuard,
  installGuard,
  opaqueShellGuard,
];

/** Block prompt returned when a guard or gate throws (fail-closed). */
export const FAIL_CLOSED: Prompt = {
  kind: "block",
  title: "Policy error",
  reason: "A policy check errored — blocked for safety (fail-closed).",
  actions: ["Fix the failing guard/gate, then retry"],
};

const USER_GUARDS: Guard[] = [];

/** Register a user guard — runs AFTER the privileged core chain (two-tier). */
export function registerGuard(guard: Guard): void {
  USER_GUARDS.push(guard);
}

/** Remove all registered user guards (mainly for tests). */
export function clearUserGuards(): void {
  USER_GUARDS.length = 0;
}

/**
 * Run the guard chain — privileged core guards first, then user guards — and
 * return the first firing Prompt, else null. Fail-closed: a guard that throws
 * blocks (never silently passes).
 */
export function runGuards(ctx: GuardContext): Prompt | null {
  for (const guard of [...GUARDS, ...USER_GUARDS]) {
    let hit: Prompt | null;
    try {
      hit = guard(ctx);
    } catch {
      return FAIL_CLOSED;
    }
    if (hit) return hit;
  }
  return null;
}

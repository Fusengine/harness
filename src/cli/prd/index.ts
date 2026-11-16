/**
 * `harness prd <status|validate|compact|init>` — CLI entry point for the PRD
 * (task/agent ownership coordination) module.
 */
export * from "./resolve";
export * from "./format";
export { runPrdStatus } from "./status";
export { runPrdValidate } from "./validate";
export { runPrdCompact } from "./compact";
export { runPrdInit } from "./init";

import { runPrdStatus } from "./status";
import { runPrdValidate } from "./validate";
import { runPrdCompact } from "./compact";
import { runPrdInit } from "./init";

/** Dispatch `harness prd <sub> ...rest` to the matching `run*` function. */
export async function runPrd(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return runPrdStatus(rest, cwd, env);
  if (sub === "validate") return runPrdValidate(rest, cwd, env);
  if (sub === "compact") return runPrdCompact(rest, cwd, env);
  if (sub === "init") return runPrdInit(rest, cwd, env);
  process.stderr.write(`harness prd: unknown sub-command "${sub ?? ""}" (expected status|validate|compact|init)\n`);
  return 2;
}

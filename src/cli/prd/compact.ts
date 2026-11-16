/**
 * `harness prd compact <task> [--id] [--root]` — collapses every fully
 * validated agent entry of a task-PRD to its compacted shape. Requires
 * `FUSE_PRD=1`; refuses (exit 1) when any sub-task is not yet `validated`.
 */
import { writeTaskFile } from "../../policy/prd/prd-io";
import { compactTaskFile } from "../../policy/prd/prd-compact";
import { isCompacted, subTasksOf } from "../../policy/prd/prd-schema";
import { requireTaskFile, withPrdLock } from "./shared";

/**
 * Run `harness prd compact`. Exit 0 on success (including a no-op compact),
 * exit 1 when `FUSE_PRD` is unset, a sub-task is unvalidated, or the lock is
 * held, exit 2 on usage/lookup errors.
 */
export async function runPrdCompact(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const tf = await requireTaskFile(argv, cwd, env, "compact", "usage: harness prd compact <task>");
  if (!tf.ok) {
    process.stderr.write(tf.message + "\n");
    return tf.code;
  }
  const { root, homeSeg, routerEntry, taskFile } = tf;

  for (const [agent, entry] of Object.entries(taskFile)) {
    if (isCompacted(entry)) continue;
    for (const [sub, status] of Object.entries(subTasksOf(entry))) {
      if (status.status !== "validated") {
        process.stderr.write(`prd compact: sub-task "${sub}" of agent "${agent}" is not validated\n`);
        return 1;
      }
    }
  }

  const result = await withPrdLock(root, homeSeg, async () => {
    const now = new Date().toISOString();
    const { file, compacted } = compactTaskFile(taskFile, now);
    await writeTaskFile(root, homeSeg, routerEntry.prd, file);
    return compacted;
  });
  if (!result.ok) {
    process.stderr.write(`prd compact: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(result.value.length > 0 ? `compacted: ${result.value.join(", ")}\n` : "nothing to compact\n");
  return 0;
}

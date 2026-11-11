import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real, empty, non-/dev directory (fixed name, created once, shared by every test file) standing in for the host
 * payload `cwd`: the literal-write block resolves relative targets against it, so a relative fresh name is "ordinary".
 */
export const REAL_CWD: string = (() => {
  const dir = join(realpathSync(tmpdir()), "fh-bw-real-cwd");
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();

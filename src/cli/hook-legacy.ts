/**
 * The historical one-process-per-hook path of `harness hook <id> [scope]`,
 * moved VERBATIM out of `bin.ts` (which must stay light so a rendezvous follower
 * never loads the runtime). Used when the rendezvous is disabled
 * (`FUSE_HARNESS_RENDEZVOUS=0`) or the invocation is not eligible (extra flags
 * such as `--sound`, missing id/scope). Behaviour is byte-identical to before.
 */
import { detectHarness, type HarnessId } from "../detect/harness";
import { handleHook } from "../runtime/handle";
import { resolveTtlSec } from "../config/ttl";
import { loadDotenv } from "../config/dotenv";
import { homedir } from "node:os";
import { refsDirFor } from "../refs/refs-override";
import { hostHome, messageHost } from "../policy/host-skill-paths";
import { parseScope } from "./scope";
import { isMalformedCursorStdin, isOversize, oversizeStdout, readStdin, traceHook } from "./hook-io";
import { exitHook, stdinReaderBlocked } from "./stdin-source";
import { maybePlaySound } from "./hook-sound";

/**
 * Run one hook invocation exactly as `bin.ts` always did, then exit the process.
 * @param argv - `process.argv` (`[runtime, bin, "hook", id?, scope?, ...flags]`).
 */
export async function runLegacyHook(argv: string[]): Promise<never> {
  const id = argv[3] ?? detectHarness().id;
  loadDotenv(id as HarnessId);
  const scope = parseScope(argv[4]);
  if (maybePlaySound(argv)) process.exit(0);
  const marketplaces = (process.env.FUSE_HARNESS_MARKETPLACES ?? "fusengine-plugins").split(",").map((s) => s.trim()).filter(Boolean);
  // refs are only consumed on the PreToolUse path: resolved on first read, memoized
  let refsMemo: { value: string | undefined } | undefined;
  const lazyRefsDir = (): string | undefined => {
    refsMemo ??= { value: refsDirFor(homedir(), process.cwd(), marketplaces, messageHost(id), process.env, hostHome()) };
    return refsMemo.value;
  };
  traceHook("args", { id, scope });
  let outcome: Awaited<ReturnType<typeof handleHook>>;
  try {
    const stdin = await readStdin(id);
    if (isOversize(stdin)) {
      const stdout = oversizeStdout(id, stdin.head, stdin.stalled === true);
      if (stdout) process.stdout.write(stdout);
      await exitHook(0);
    }
    if (isMalformedCursorStdin(stdin)) await exitHook(1);
    outcome = await handleHook(id, stdin, {
      now: Date.now(),
      cwd: process.cwd(),
      get refsDir(): string | undefined { return lazyRefsDir(); },
      windowMs: resolveTtlSec(process.env) * 1000,
      scope,
    });
  } catch (e) {
    traceHook("handleHook-threw", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    if (stdinReaderBlocked()) { process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`); await exitHook(1); }
    throw e;
  }
  traceHook("outcome", { stdoutLength: outcome.stdout.length, exit: outcome.exit });
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  return exitHook(outcome.exit);
}

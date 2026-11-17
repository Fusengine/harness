/**
 * One hook invocation as a function: everything `harness hook <id> <scope>` does
 * AFTER stdin was read, minus printing and exiting. Shared by the standalone
 * fallback of a rendezvous process and by the leader (which calls it once per
 * registered scope). Mirrors `hook-legacy.ts` step for step; the differential
 * test pins them to the same bytes.
 */
import { handleHook } from "../runtime/handle";
import { resolveTtlSec } from "../config/ttl";
import { loadDotenv } from "../config/dotenv";
import { discoverRefs } from "../refs/discover";
import type { HarnessId } from "../detect/harness";
import { homedir } from "node:os";
import { parseScope } from "./scope";
import { isMalformedCursorStdin, isOversize, oversizeStdout, parseStdinRead } from "./hook-io";
import { traceHook, type StdinRead } from "./stdin-text";
import { stdinReaderBlocked } from "./stdin-source";

/** Inputs of {@link runHookOnce}. */
export interface HookRunInput {
  id: string;
  /** `argv[4]` of the invocation (undefined = core). */
  scopeArg: string | undefined;
  /** The already-read stdin. */
  read: StdinRead;
  /** Sink for the unknown-scope warning (defaults to stderr). */
  errSink?: (msg: string) => void;
}

/** What the invocation prints and exits with (stderr is written directly, see leader capture). */
export interface HookRunOutput {
  stdout: string;
  exit: number;
}

/**
 * Run one hook invocation to completion.
 * @param input - Harness id, scope argument and the stdin read result.
 * @throws whatever `handleHook` throws (the standalone caller lets it crash like today).
 */
export async function runHookOnce(input: HookRunInput): Promise<HookRunOutput> {
  const { id } = input;
  loadDotenv(id as HarnessId);
  const scope = parseScope(input.scopeArg, input.errSink);
  const marketplaces = (process.env.FUSE_HARNESS_MARKETPLACES ?? "fusengine-plugins").split(",").map((s) => s.trim()).filter(Boolean);
  let refsMemo: { value: string | undefined } | undefined;
  const lazyRefsDir = (): string | undefined => {
    refsMemo ??= { value: process.env.FUSE_HARNESS_REFS || discoverRefs(homedir(), process.cwd(), marketplaces, id) || undefined };
    return refsMemo.value;
  };
  let outcome: Awaited<ReturnType<typeof handleHook>>;
  try {
    const stdin = parseStdinRead(id, input.read);
    if (isOversize(stdin)) return { stdout: oversizeStdout(id, stdin.head, stdin.stalled === true), exit: 0 };
    if (isMalformedCursorStdin(stdin)) return { stdout: "", exit: 1 };
    outcome = await handleHook(id, stdin, {
      now: Date.now(),
      cwd: process.cwd(),
      get refsDir(): string | undefined { return lazyRefsDir(); },
      windowMs: resolveTtlSec(process.env) * 1000,
      scope,
    });
  } catch (e) {
    traceHook("handleHook-threw", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    if (stdinReaderBlocked()) {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      return { stdout: "", exit: 1 };
    }
    throw e;
  }
  traceHook("outcome", { stdoutLength: outcome.stdout.length, exit: outcome.exit });
  return { stdout: outcome.stdout, exit: outcome.exit };
}

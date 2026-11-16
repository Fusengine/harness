/**
 * Local test fixtures/capture helpers for `test/cli/prd.test.ts` (Lot C).
 * Deliberately independent of `test/helpers/prd-env.ts` (Lot D) to avoid a
 * cross-lot coupling edge during parallel development.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh `mkdtemp`-scoped root dir (caller is responsible for cleanup). */
export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "fh-prd-cli-"));
}

/** Per-file tracker of {@link tmpRoot} dirs: `root()` creates one, `cleanup()` (an `afterEach`) removes them all. */
export function tmpRootTracker(): { root: () => string; cleanup: () => void } {
  const roots: string[] = [];
  return {
    root: () => {
      const dir = tmpRoot();
      roots.push(dir);
      return dir;
    },
    cleanup: () => {
      while (roots.length > 0) {
        const dir = roots.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, "..", "."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** `<root>/.claude/apex/**` fixture: router + 2-agent task-PRD (+ optional 2nd report). */
export function buildFixture(root: string, secondReport = false): void {
  const apex = join(root, ".claude", "apex");
  writeJson(join(apex, "prd.json"), { "auth-refactor": { prd: "prd/auth-refactor-prd.json", status: "assigned" } });
  writeJson(join(apex, "prd", "auth-refactor-prd.json"), {
    "backend-expert": { files: ["src/auth/login.ts"], "sub-tasks": { "jwt-validation": { status: "assigned" } } },
    "backend-expert-2": { files: ["src/auth/session.ts"], "sub-tasks": { "session-store": { status: "assigned" } } },
  });
  writeJson(join(apex, "prd", "agents", "backend-expert-prd.json"), {
    "auth-refactor": { "jwt-validation": { status: "done", modified: ["src/auth/login.ts"], unchanged: [] } },
  });
  if (secondReport) {
    writeJson(join(apex, "prd", "agents", "backend-expert-2-prd.json"), {
      "auth-refactor": { "session-store": { status: "done", modified: ["src/auth/session.ts"], unchanged: [] } },
    });
  }
}

/** Write an extra router (e.g. under `.codex`), to trigger a `--id` ambiguity. */
export function writeExtraRouter(root: string, homeSeg: string): void {
  writeJson(join(root, homeSeg, "apex", "prd.json"), {
    "auth-refactor": { prd: "prd/auth-refactor-prd.json", status: "assigned" },
  });
}

/** Result of a captured `run*` call. */
export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `run`, capturing everything it writes to stdout/stderr. */
export async function capture(run: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { out.push(String(c)); return true; }) as unknown as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err.push(String(c)); return true; }) as unknown as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

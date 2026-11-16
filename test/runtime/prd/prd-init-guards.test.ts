/**
 * Guard witnesses for `harness prd init`, driven through the REAL hook entry
 * (`handleHook`, claude-code, lead = no `agent_id`, `FUSE_PRD=1`, router absent).
 * Pins that init needs NO hole in protectedPathGuard/prdPreGate: the router
 * stays unwritable by direct Write, while the CLI path is not blocked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../../../src/runtime/handle";
import { runPrdInit } from "../../../src/cli/prd/init";
import { prdAgentReportPath, prdRouterPath, prdTaskPath } from "../../../src/policy/prd";
import { capture } from "../../cli/prd-fixtures";
import { denyReason, isDenied } from "./prd-pre-gate-helpers";

const NOW = 1_700_000_000_000;
const SESSION = "s-init";
const HOME_SEG = ".claude";

let root = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fh-prd-init-guards-"));
  mkdirSync(join(root, HOME_SEG), { recursive: true });
  // HOME is isolated on the command line (Bun caches os.homedir(); in-process assignment is a no-op).
  for (const k of ["FUSE_PRD", "CLAUDE_PROJECT_DIR"]) saved[k] = process.env[k];
  process.env.FUSE_PRD = "1";
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

async function hook(toolName: string, toolInput: Record<string, unknown>, agent?: { id: string; type: string }) {
  return handleHook("claude-code", {
    hook_event_name: "PreToolUse", tool_name: toolName, session_id: SESSION, tool_input: toolInput,
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  }, { now: NOW, cwd: root, home: root });
}

const write = (path: string, agent?: { id: string; type: string }) => hook("Write", { file_path: path, content: "{}" }, agent);
const router = (): string => prdRouterPath(root, HOME_SEG);

describe("prd init — guard pins (real hook entry, router absent)", () => {
  test("init-guard-pin: Bash `harness prd init` is not blocked by any guard", async () => {
    const out = await hook("Bash", { command: "harness prd init --id claude-code --task t" });
    expect(isDenied(out.stdout)).toBe(false);
    const bare = await hook("Bash", { command: "harness prd init --id claude-code" });
    expect(isDenied(bare.stdout)).toBe(false);
  });

  test("init-no-generic-hole-witness: direct Write of the router is still BLOCKED in that state", async () => {
    expect(existsSync(router())).toBe(false);
    const out = await write(router());
    expect(isDenied(out.stdout)).toBe(true);
    expect(denyReason(out.stdout)).toContain("internal/generated enforcement state");
  });

  test("init-then-lead-flow: after init the lead writes the task PRD, not agent reports; sub-agents cannot write the router", async () => {
    const run = await capture(() => runPrdInit(["--root", root, "--id", "claude-code", "--task", "t"], root, { FUSE_PRD: "1" }));
    expect(run.code).toBe(0);
    expect(existsSync(router())).toBe(true);

    const taskWrite = await write(prdTaskPath(root, HOME_SEG, "prd/t-prd.json"));
    expect(isDenied(taskWrite.stdout)).toBe(false);

    const reportWrite = await write(prdAgentReportPath(root, HOME_SEG, "backend-expert"));
    expect(isDenied(reportWrite.stdout)).toBe(true);

    const subRouter = await write(router(), { id: "a1", type: "backend-expert" });
    expect(isDenied(subRouter.stdout)).toBe(true);
  });
});

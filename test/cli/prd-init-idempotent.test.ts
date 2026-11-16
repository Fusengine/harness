/**
 * `harness prd init` idempotency: a re-run (sub-agents may run init too) must report
 * `exists`, print the same absolute agents-dir line as on creation, and write nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runPrdInit } from "../../src/cli/prd/init";
import { prdAgentReportPath, prdRouterPath } from "../../src/policy/prd/prd-paths";
import { capture, tmpRootTracker } from "./prd-fixtures";

const PRD_ON = { FUSE_PRD: "1" };
const { root, cleanup } = tmpRootTracker();

afterEach(cleanup);

/** `relative path -> sha256@mtime` of every file under `dir` (recursive): a rewrite changes either part. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) snapshot(full, base, out);
    else out[full.slice(base.length)] = `${createHash("sha256").update(readFileSync(full)).digest("hex")}@${statSync(full).mtimeMs}`;
  }
  return out;
}

const init = (r0: string, extra: string[] = []) => capture(() => runPrdInit(["--root", r0, "--id", "claude-code", ...extra], r0, PRD_ON));
const lines = (s: string): string[] => s.split("\n").filter(Boolean);
const agentsLine = (r0: string): string =>
  `prd init: agent reports go in ${dirname(prdAgentReportPath(r0, ".claude", "x"))}/<agent>-prd.json (absolute path — never <project>/prd/agents/)`;

describe("harness prd init is idempotent", () => {
  test("created then exists: same agents-dir line, exit 0 both times", async () => {
    const r0 = root();
    const router = prdRouterPath(r0, ".claude");
    const first = await init(r0, ["--task", "utilities"]);
    expect(first.code).toBe(0);
    expect(lines(first.stdout)).toEqual([`prd init: created ${router} with task "utilities"`, agentsLine(r0)]);
    const second = await init(r0, ["--task", "utilities"]);
    expect(second.code).toBe(0);
    expect(lines(second.stdout)).toEqual([`prd init: exists ${router} with task "utilities"`, agentsLine(r0)]);
    expect(second.stderr).toBe("");
  });

  test("exists without --task: no `with task` suffix", async () => {
    const r0 = root();
    await init(r0);
    const again = await init(r0);
    expect(again.code).toBe(0);
    expect(lines(again.stdout)).toEqual([`prd init: exists ${prdRouterPath(r0, ".claude")}`, agentsLine(r0)]);
  });

  test("2nd and 3rd init write nothing: router, task PRD, slots and reports byte-identical", async () => {
    const r0 = root();
    await init(r0, ["--task", "utilities"]);
    const apex = join(r0, ".claude", "apex");
    mkdirSync(join(apex, "prd", "agents"), { recursive: true });
    writeFileSync(join(apex, "prd", "utilities-prd.json"), JSON.stringify({ a: { files: ["x.ts"], "sub-tasks": { s: { status: "assigned" } } } }));
    writeFileSync(join(apex, "prd", "agents", "a-prd.json"), JSON.stringify({ utilities: { s: { status: "done", modified: [], unchanged: [] } } }));
    const before = snapshot(r0);
    for (let i = 0; i < 2; i++) expect((await init(r0, ["--task", "utilities"])).code).toBe(0);
    expect(snapshot(r0)).toEqual(before);
  });

  test("a task already in a multi-task router is reported as existing", async () => {
    const r0 = root();
    mkdirSync(join(r0, ".claude", "apex"), { recursive: true });
    const original = JSON.stringify({ t1: { prd: "prd/t1-prd.json", status: "in-progress" }, t2: { prd: "prd/t2-prd.json", status: "assigned" } });
    writeFileSync(prdRouterPath(r0, ".claude"), original);
    const r = await init(r0, ["--task", "t2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`prd init: exists ${prdRouterPath(r0, ".claude")} with task "t2"`);
    expect(r.stdout).toContain(agentsLine(r0));
    expect(readFileSync(prdRouterPath(r0, ".claude"), "utf8")).toBe(original);
  });

  test("unchanged failure modes: missing task exit 1, malformed exit 1, no FUSE_PRD exit 1", async () => {
    const r0 = root();
    await init(r0, ["--task", "t1"]);
    const missing = await init(r0, ["--task", "t2"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    const bad = root();
    mkdirSync(join(bad, ".claude", "apex"), { recursive: true });
    writeFileSync(prdRouterPath(bad, ".claude"), "{not json");
    const malformed = await init(bad, ["--task", "t"]);
    expect(malformed.code).toBe(1);
    expect(readFileSync(prdRouterPath(bad, ".claude"), "utf8")).toBe("{not json");
    const off = await capture(() => runPrdInit(["--root", r0, "--id", "claude-code"], r0, {}));
    expect(off.code).toBe(1);
    expect(off.stderr).toContain("FUSE_PRD=1");
  });

  test("same project, root given as cwd or as absolute path with trailing slash, hits one router", async () => {
    const r0 = root();
    const first = await capture(() => runPrdInit(["--id", "claude-code", "--task", "u"], r0, PRD_ON)); // root = cwd
    const second = await init(`${r0}/`, ["--task", "u"]);
    expect(first.stdout).toContain("created");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("exists");
  });
});

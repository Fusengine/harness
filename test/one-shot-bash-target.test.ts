import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { oneShotSummary, SIDECAR, WINDOW_MS } from "../src/tracking/one-shot";
import { applyAllow, applyDeny, EMPTY, pruneState, type OneShotEvent } from "../src/tracking/one-shot-store";
import { bashWriteTargets, isBashWriteTitle, normalizeTarget } from "../src/tracking/one-shot-target";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { trackFile, defaultStateDir } from "../src/runtime/paths";
import { projectStateDir } from "../src/runtime/project-state-dir";
import { gate, type GateInput } from "../src/runtime/gate";

const tmp = (): string => mkdtempSync(join(tmpdir(), "fh-oneshot-bt-"));
const BASH = "Bash write to code file";

/** Drive one tool-use through the REAL gate, wired like handle.ts (state dir from the project cwd). */
function drive(cwd: string, extra: Partial<GateInput>, now: number, sid = "s1") {
  return gate({ sessionId: sid, framework: "generic", windowMs: 10000, cwd, now, trackFile: trackFile(sid, defaultStateDir(cwd)), ...extra } as GateInput);
}
const events = (cwd: string): OneShotEvent[] =>
  (JSON.parse(readFileSync(join(projectStateDir(cwd), SIDECAR), "utf8")) as { events?: OneShotEvent[] }).events ?? [];

test("the real guard still titles a Bash code-file write with a title isBashWriteTitle accepts", () => {
  const p = bashWriteGuard({ tool: "Bash", command: "echo x > src/a.ts" } as never);
  expect(p?.kind).toBe("block");
  expect(isBashWriteTitle(p?.title ?? "")).toBe(true);
});

test("REPRO: Bash-write deny on T then Write/Edit on T credits the Bash-write gate (was 1den/0fix)", async () => {
  const cwd = tmp(); const now = Date.now();
  const denied = await drive(cwd, { tool: "Bash", command: "echo x > src/a.ts" }, now);
  expect(denied?.kind).toBe("block");
  expect(await drive(cwd, { tool: "Edit", filePath: join(cwd, "src/a.ts"), content: "a\nb" }, now + 10)).toBeNull();
  const out = oneShotSummary(cwd);
  expect(out).toContain(`${BASH} 1den/1fix`);
  expect(out).toContain("one-shot (0/1 clean)");
  expect(events(cwd).map((e) => e.outcome)).toEqual(["denied", "corrected"]);
  expect(events(cwd)[1]).toMatchObject({ gate: BASH, sid: "s1", target: join(cwd, "src/a.ts") });
});

test("a Write/Edit on a DIFFERENT file does not credit the Bash-write gate", async () => {
  const cwd = tmp(); const now = Date.now();
  await drive(cwd, { tool: "Bash", command: "echo x > src/a.ts" }, now);
  await drive(cwd, { tool: "Edit", filePath: join(cwd, "src/b.ts"), content: "a\nb" }, now + 10);
  expect(oneShotSummary(cwd)).toContain(`${BASH} 1den/0fix`);
});

test("repeated deny (same target) is logged denied-again; an abandoned deny is logged abandoned", async () => {
  const cwd = tmp(); const now = Date.now();
  await drive(cwd, { tool: "Bash", command: "echo x > src/a.ts" }, now);
  await drive(cwd, { tool: "Bash", command: "printf y > src/a.ts" }, now + 10); // different command, same target
  expect(events(cwd).map((e) => e.outcome)).toEqual(["denied", "denied-again"]);
  // never fixed: the next record past the abandon horizon logs both as abandoned
  process.env.FUSE_ONESHOT_ABANDON_MS = "1000";
  try { await drive(cwd, { tool: "Bash", command: "echo z > src/c.ts" }, now + 5000); } finally { delete process.env.FUSE_ONESHOT_ABANDON_MS; }
  const out = events(cwd).map((e) => e.outcome);
  expect(out.filter((o) => o === "abandoned")).toHaveLength(2);
});

test("pure model: target credit is global +1 per allow, only Bash-write pendings carry targets", () => {
  let s = applyDeny({ ...EMPTY }, BASH, "cmd1", 1, { targets: ["/p/a.ts"] });
  s = applyDeny(s, "SOLID file-size limit", "opW", 2); // no targets: never target-credited
  const after = applyAllow(s, "opE", 3, true, { target: "/p/a.ts" });
  expect(after.corrected).toBe(1);
  expect(after.gates[BASH]).toMatchObject({ corrected: 1 });
  expect(after.gates["SOLID file-size limit"]).toMatchObject({ corrected: 0 });
  expect(after.pending.opW).toBeDefined();
});

test("pure model: default abandon horizon = metric window; pending survives below it", () => {
  const s = applyDeny({ ...EMPTY }, BASH, "c", 1000, { targets: ["/p/a.ts"] });
  expect(Object.keys(pruneState(s, 1000 + WINDOW_MS - 1, WINDOW_MS).pending)).toEqual(["c"]);
});

test("a fix from ANOTHER session does not credit the deny; same session does", () => {
  const s = applyDeny({ ...EMPTY }, BASH, "c", 1, { targets: ["/p/a.ts"], sid: "S1" });
  expect(applyAllow(s, "e", 2, true, { target: "/p/a.ts", sid: "S2" }).corrected).toBe(0);
  expect(applyAllow(s, "e", 2, true, { target: "/p/a.ts", sid: "S1" }).corrected).toBe(1);
});

test("bashWriteTargets: leading `cd dir &&` re-bases relative targets; a mid-command cd yields none", () => {
  expect(bashWriteTargets("cd sub && echo x > a.ts", "/w")).toEqual(["/w/sub/a.ts"]);
  expect(bashWriteTargets("echo x > a.ts; cd sub; echo y > b.ts", "/w")).toEqual([]);
});

test("normalizeTarget: symlinked parent dirs compare equal (/tmp vs /private/tmp)", () => {
  const real = realpathSync(tmpdir());
  const link = join(tmp(), "ln");
  symlinkSync(real, link);
  expect(normalizeTarget(join(link, "x.ts"))).toBe(normalizeTarget(join(real, "x.ts")));
});

test("bashWriteTargets: no redirect -> only the writing segment's code files (read-only neighbours excluded)", () => {
  expect(bashWriteTargets("sed -i s/x/y/ src/a.ts && cat src/c.ts", "/w")).toEqual(["/w/src/a.ts"]);
  expect(bashWriteTargets("cat src/c.ts | sed -i s/x/y/ src/a.ts; ls lib.ts", "/w")).toEqual(["/w/src/a.ts"]);
  expect(bashWriteTargets("ls lib.ts\nsed -i s/x/y/ src/a.ts", "/w")).toEqual(["/w/src/a.ts"]);
});

test("bashWriteTargets: redirect targets win; words with shell expansion are skipped", () => {
  expect(bashWriteTargets("echo x > /r/a.ts", "/w")).toEqual(["/r/a.ts"]);
  expect(bashWriteTargets("cat src/b.ts > out/a.ts", "/w")).toEqual(["/w/out/a.ts"]);
  expect(bashWriteTargets("sed -i s/a/b/ src/c.ts", "/w")).toEqual(["/w/src/c.ts"]);
  expect(bashWriteTargets("echo x > $D/a.ts", "/w")).toEqual([]);
});

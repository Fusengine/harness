import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, run, bash, prompt, codeOf, type MotionFixture } from "./motion-handle-fixture";
import { canonicalRoot } from "../src/runtime/prd/prd-canon";
import { rootKey } from "../src/policy/motion/hash";
import { projectStoreDir } from "../src/policy/motion/store";
import { quarantineArtifact } from "../src/policy/motion/state-files";
import { runHost } from "./motion-hosts-fixture";
import { loadBudget } from "../src/policy/motion/budget";
import { readMotionState } from "../src/policy/motion/state";

const fixtures: MotionFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true }); });

for (const mode of ["remove", "replace"] as const) test(`registry ${mode} still quarantines changed output and persists invalidation`, async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("recover", "ls"));
  const registry = join(f.home, ".fuse-harness/video-motion/state", `${rootKey(canonicalRoot(f.proj))}.json`);
  if (mode === "remove") unlinkSync(registry); else writeFileSync(registry, "{}");
  writeFileSync(f.draft, "changed");
  const out = await run(f, { hook_event_name: "PostToolUse", session_id: "recover", tool_name: "Read" });
  expect(existsSync(f.draft)).toBe(false);
  expect(out).toContain("invalidated");
  expect(JSON.parse(readFileSync(registry, "utf8")).invalid).toBe(true);
});

test("non-directory protected store cannot prevent output quarantine", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("store-failure", "ls"));
  const store = projectStoreDir(canonicalRoot(f.proj), f.home);
  writeFileSync(store, "not a directory");
  writeFileSync(f.draft, "changed");
  const out = await run(f, { hook_event_name: "PostToolUse", session_id: "store-failure", tool_name: "Read" });
  expect(existsSync(f.draft)).toBe(false);
  expect(out).toContain("invalidated");
});

test("unrelated Read and post preserve intermediate output of one active authorized render", async () => {
  const f = makeFixture(); fixtures.push(f);
  const denied = await run(f, bash("active", "bash render.sh --stage draft"));
  await run(f, prompt("active", `MOTION-APPROVE stills ${codeOf(denied)}`));
  await run(f, bash("active", "bash render.sh --stage draft", { tool_use_id: "active-render" }));
  writeFileSync(f.draft, "intermediate");
  await run(f, { hook_event_name: "PreToolUse", session_id: "active", tool_name: "Read", tool_input: { file_path: "src/read.ts" }, tool_use_id: "read" });
  await run(f, { hook_event_name: "PostToolUse", session_id: "active", tool_name: "Read", tool_use_id: "read" });
  expect(existsSync(f.draft)).toBe(true);
});

test("EXDEV quarantine moves bytes locally without deleting or retaining source", () => {
  const f = makeFixture(); fixtures.push(f);
  const original = fs.renameSync;
  let first = true;
  const spy = spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (first) { first = false; throw Object.assign(new Error("different filesystem"), { code: "EXDEV" }); }
    return original(source, target);
  });
  try {
    const destination = quarantineArtifact(f.draft, f.proj);
    expect(destination).toContain(".motion-quarantine");
    expect(existsSync(f.draft)).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("draft-v1");
  } finally { spy.mockRestore(); }
});

test("another host with the same session and native id cannot earn the render receipt", async () => {
  const f = makeFixture(); fixtures.push(f);
  const denied = await run(f, bash("same", "bash render.sh --stage draft"));
  await run(f, prompt("same", `MOTION-APPROVE stills ${codeOf(denied)}`));
  const pre = bash("same", "bash render.sh --stage draft", { tool_use_id: "shared-id" });
  await run(f, pre);
  const root = canonicalRoot(f.proj);
  const inflight = loadBudget(root, f.home).inflight;
  const receipts = readMotionState(root, f.home)?.renders;
  writeFileSync(f.draft, "foreign-host-result");
  const out = await runHost(f, "kimi", { hook_event_name: "PostToolUse", session_id: "same", tool_call_id: "shared-id", tool_name: "Bash", tool_input: { command: "bash render.sh --stage draft" } });
  // M1 preserves active output; a foreign host still cannot settle or earn its receipt.
  expect(out).not.toContain("quarantin");
  expect(readFileSync(f.draft, "utf8")).toBe("foreign-host-result");
  expect(loadBudget(root, f.home).inflight).toEqual(inflight);
  expect(loadBudget(root, f.home).renders.draft ?? 0).toBe(0);
  expect(readMotionState(root, f.home)?.renders).toEqual(receipts);
  expect(readMotionState(root, f.home)?.coldArtifacts).toContain(join(root, "out/draft.mp4"));
  await run(f, { ...pre, hook_event_name: "PostToolUse" });
  expect(loadBudget(root, f.home).inflight).toEqual({});
  expect(loadBudget(root, f.home).renders.draft).toBe(1);
  expect(readMotionState(root, f.home)?.renders).toEqual({});
  expect(readMotionState(root, f.home)?.coldArtifacts).not.toContain(join(root, "out/draft.mp4"));
});

test("permission failure explicitly preserves data and persists invalidation", async () => {
  const f = makeFixture(); fixtures.push(f);
  await run(f, bash("permission", "ls"));
  writeFileSync(f.draft, "changed-but-unmovable");
  const original = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((source, target) => {
    if (String(source).endsWith("draft.mp4")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original(source, target);
  });
  try {
    const out = await run(f, { hook_event_name: "PostToolUse", session_id: "permission", tool_name: "Read" });
    expect(out).toContain("QUARANTINE FAILED");
    expect(readFileSync(f.draft, "utf8")).toBe("changed-but-unmovable");
    const registry = join(f.home, ".fuse-harness/video-motion/state", `${rootKey(canonicalRoot(f.proj))}.json`);
    expect(JSON.parse(readFileSync(registry, "utf8")).invalid).toBe(true);
  } finally { spy.mockRestore(); }
});

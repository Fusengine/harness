import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextResponse, denyResponse } from "../src/adapters/claude";
import { bash, codeOf, isDeny, prompt, run } from "./motion-handle-fixture";
import { denied, makeFixture, runHost, shell, silent, userPrompt } from "./motion-hosts-fixture";

const DRAFT = "bash render.sh --stage draft";
const STORE = (home: string): string => join(home, ".fuse-harness", "video-motion", "x", "approvals.json");

test("claude-code: motion outputs are exactly the Claude builders' bytes (deny, approval, budget)", async () => {
  const fx = makeFixture();
  await run(fx, bash("s1", "ls"));
  const denial = await run(fx, bash("s1", DRAFT));
  const reason = JSON.parse(denial).hookSpecificOutput.permissionDecisionReason as string;
  expect(denial).toBe(denyResponse("PreToolUse", reason));
  expect(reason.startsWith("[BLOCKED] Motion approval gate\n")).toBe(true);
  const granted = await run(fx, prompt("s1", `MOTION-APPROVE stills ${codeOf(denial)}`));
  expect(granted).toBe(contextResponse("UserPromptSubmit", `Motion: stage "stills" approved for ${realpathSync(fx.contact)} (sha ${JSON.parse(granted).hookSpecificOutput.additionalContext.match(/sha ([0-9a-f]{8})/)[1]}). The next stage may now run.`));
  const ok = await run(fx, bash("s2", DRAFT));
  expect(JSON.parse(ok).hookSpecificOutput.hookEventName).toBe("PreToolUse");
});

test("codex apply_patch: the store path anywhere in the patch markers (Add, Update, Move to) is refused; a source path is not", async () => {
  const fx = makeFixture();
  const patch = (body: string): Record<string, unknown> => ({ hook_event_name: "PreToolUse", session_id: "s1", turn_id: "1", tool_use_id: "t", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` }, cwd: fx.proj });
  const store = STORE(fx.home);
  expect(denied("codex", await runHost(fx, "codex", patch(`*** Update File: ${store}\n@@\n-a\n+b`)))).toBe(true);
  expect(denied("codex", await runHost(fx, "codex", patch(`*** Update File: ${fx.proj}/src/a.ts\n*** Move to: ${store}\n@@\n-a\n+b`)))).toBe(true);
  expect(denied("codex", await runHost(fx, "codex", patch(`*** Update File: ${store}\n*** Move to: ${fx.proj}/src/b.ts\n@@\n-a\n+b`)))).toBe(true);
  expect(denied("codex", await runHost(fx, "codex", patch(`*** Delete File: ${store}`)))).toBe(true);
  expect(denied("codex", await runHost(fx, "codex", patch(`*** Add File: ${fx.proj}/src/a.ts\n+const x = 1`)))).toBe(false);
});

test("codex apply_patch: a banned term in an added source file is refused", async () => {
  const fx = makeFixture();
  mkdirSync(join(fx.home, ".fuse-harness", "video-motion"), { recursive: true });
  writeFileSync(join(fx.home, ".fuse-harness", "video-motion", "banned.txt"), "acmecorp\n");
  const body = `*** Add File: ${realpathSync(fx.proj)}/src/a.ts\n+// AcmeCorp`;
  const out = await runHost(fx, "codex", { hook_event_name: "PreToolUse", session_id: "s1", turn_id: "1", tool_use_id: "t", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` }, cwd: fx.proj });
  expect(denied("codex", out)).toBe(true);
});

test("hermes patch (V4A string) into the store is refused", async () => {
  const fx = makeFixture();
  const patch = `*** Begin Patch\n*** Add File: ${STORE(fx.home)}\n+{}\n*** End Patch`;
  const out = await runHost(fx, "hermes", { hook_event_name: "pre_tool_call", session_id: "s1", tool_name: "patch", tool_input: { mode: "patch", patch }, cwd: fx.proj });
  expect(denied("hermes", out)).toBe(true);
});

test("gemini replace / cline replace_in_file on the store are refused", async () => {
  const fx = makeFixture();
  const g = await runHost(fx, "gemini-cli", { hook_event_name: "BeforeTool", session_id: "s1", tool_name: "replace", tool_input: { file_path: STORE(fx.home), old_string: "a", new_string: "b" }, cwd: fx.proj });
  expect(denied("gemini-cli", g)).toBe(true);
  const c = await runHost(fx, "cline", { hookName: "PreToolUse", taskId: "s1", preToolUse: { toolName: "replace_in_file", parameters: { path: STORE(fx.home), diff: "x" } } });
  expect(denied("cline", c)).toBe(true);
});

test("cursor: a sub-agent conversation (parent_tool_call_id) never approves; claude agent_id neither", async () => {
  const fx = makeFixture();
  const c = codeOf(await runHost(fx, "cursor", shell("cursor", "s1", DRAFT, fx.proj)));
  const text = `MOTION-APPROVE stills ${c}`;
  expect(silent(await runHost(fx, "cursor", { ...userPrompt("cursor", "s1", text, fx.proj), parent_tool_call_id: "tc" }))).toBe(true);
  expect(denied("cursor", await runHost(fx, "cursor", shell("cursor", "s2", DRAFT, fx.proj)))).toBe(true);
  expect(await runHost(fx, "claude-code", { ...userPrompt("claude-code", "s1", text, fx.proj), agent_id: "a1" })).toBe("");
});

test("cursor preToolUse Shell and an unknown event: native deny / silent", async () => {
  const fx = makeFixture();
  const pre = { hook_event_name: "preToolUse", conversation_id: "s1", generation_id: "g1", tool_name: "Shell", tool_input: { command: DRAFT }, cwd: fx.proj, workspace_roots: [fx.proj] };
  expect(denied("cursor", await runHost(fx, "cursor", pre))).toBe(true);
  expect(await runHost(fx, "gemini-cli", { hook_event_name: "SessionStart", session_id: "s1", cwd: fx.proj })).toBe("");
});

test("isDeny helper still recognises the Claude shape (guard against fixture drift)", () => {
  expect(isDeny(denyResponse("PreToolUse", "x"))).toBe(true);
});

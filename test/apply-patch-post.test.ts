import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fanOutFiles, firstFileMatch } from "../src/runtime/post-fanout";
import { handlePost } from "../src/runtime/handle-post";
import { handleHook } from "../src/runtime/handle";
import { defaultStateDir, trackFile } from "../src/runtime/paths";
import { projectLayout } from "../src/config/layout";
import type { NormalizedEvent } from "../src/runtime/normalize";
import type { PreContext } from "../src/runtime/handle-pre";

const root = (): string => mkdtempSync(join(tmpdir(), "fh-appf-"));
const base = (o: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ phase: "post", tool: "apply_patch", input: {}, sessionId: "s1", ...o });

function ctxFor(cwd: string, event: NormalizedEvent, scope: PreContext["opts"]["scope"]): PreContext {
  const layout = projectLayout(cwd);
  const file = trackFile(event.sessionId, defaultStateDir(cwd));
  return { id: "codex", payload: {}, event, framework: "generic", mcpDir: layout.cacheDir, file, opts: { now: 1000, cwd, scope } };
}

test("fanOutFiles: identity for non-apply_patch (no files)", () => {
  const e = base({ tool: "Write", filePath: "a.ts", content: "x", files: undefined });
  expect(fanOutFiles(e)).toEqual([e]);
});

test("fanOutFiles: add→Write, update→Edit; delete drops content and maps off Write|Edit", () => {
  const out = fanOutFiles(base({
    files: [
      { filePath: "add.ts", content: "x", op: "add" },
      { filePath: "upd.ts", content: "y", op: "update" },
      { filePath: "del.ts", content: "unused", op: "delete" },
    ],
  }));
  expect(out.map((f) => [f.tool, f.filePath, f.content])).toEqual([
    ["Write", "add.ts", "x"],
    ["Edit", "upd.ts", "y"],
    ["apply_patch:delete", "del.ts", undefined],
  ]);
});

test("fanOutFiles: Cursor afterFileEdit preserves each old/new pair", () => {
  const event = base({
    tool: "Edit",
    files: [
      { filePath: "app.ts", oldString: "a", content: "b", op: "update" },
      { filePath: "app.ts", oldString: "c", content: "d", op: "update" },
    ],
  });
  expect(fanOutFiles(event).map((file) => [file.tool, file.filePath, file.oldString, file.content])).toEqual([
    ["Edit", "app.ts", "a", "b"],
    ["Edit", "app.ts", "c", "d"],
  ]);
});

test("firstFileMatch: OR across files, first non-empty wins (parity applyPatchGate)", () => {
  const files = fanOutFiles(base({ files: [{ filePath: "ok.ts", content: "", op: "add" }, { filePath: "bad.ts", content: "", op: "add" }] }));
  expect(firstFileMatch(files, (_t, p) => (p === "bad.ts" ? "BAD" : ""))).toBe("BAD");
  expect(firstFileMatch(files, () => "")).toBe("");
});

test("handlePost solid scope: one oversized file among an apply_patch batch denies (OR, parity Pre)", async () => {
  const cwd = root();
  const big = join(cwd, "big.ts");
  writeFileSync(big, Array.from({ length: 150 }, (_v, i) => `const l${i} = ${i};`).join("\n"));
  const small = join(cwd, "small.ts");
  writeFileSync(small, "const a = 1;\n");
  const ctx = ctxFor(cwd, base({ files: [{ filePath: small, content: "const a = 1;\n", op: "add" }, { filePath: big, content: "", op: "update" }] }), "solid");
  // Hermetic: the 150-line fixture assumes the 100-line default; a shell exporting SOLID_FILE_LIMIT=200 must not change the verdict.
  const pinned = { SOLID_PROJECT_TYPE: "generic", SOLID_FILE_LIMIT: "100" } as const;
  const saved = Object.fromEntries(Object.keys(pinned).map((k) => [k, process.env[k]]));
  Object.assign(process.env, pinned);
  try {
    const out = await handlePost(ctx);
    expect(out.stdout).toContain("SOLID");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("handlePost: a delete-only apply_patch batch is ignored by the SOLID gate (no content, no crash)", async () => {
  const cwd = root();
  mkdirSync(dirname(join(cwd, "gone.ts")), { recursive: true });
  const ctx = ctxFor(cwd, base({ files: [{ filePath: join(cwd, "gone.ts"), content: "unused", op: "delete" }] }), "solid");
  expect((await handlePost(ctx)).exit).toBe(0);
});

test("handlePost: malformed/empty apply_patch envelope (no files) fails open — no crash, allow", async () => {
  const out = await handlePost(ctxFor(root(), base({ files: undefined }), "solid"));
  expect(out.exit).toBe(0);
});

test("Pre: malformed apply_patch command text fails open (parseApplyPatch → []) — handleHook never crashes", async () => {
  const out = await handleHook("codex", { hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: "s-malformed", tool_input: { command: "not a patch at all" } }, { now: 1000, cwd: root() });
  expect(out.exit).toBe(0);
});

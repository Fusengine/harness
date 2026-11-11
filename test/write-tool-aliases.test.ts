import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard } from "../src/adapters/claude";
import { handleHook } from "../src/runtime/handle";
import { normalizeEvent } from "../src/runtime/normalize";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-wta-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A path under a harness-protected fragment (marketplace copy). */
const PROTECTED = join(root, ".claude", "plugins", "marketplaces", "m", "plugins", "p", "hooks", "hooks.json");
/** A code file whose incoming content blows far past any SOLID ceiling. */
const BIG = join(root, "src", "big.ts");
const HUGE = Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i};`).join("\n");

function payload(tool: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", session_id: `wta-${randomUUID()}`, tool_use_id: randomUUID(), cwd: root, tool_name: tool, tool_input: toolInput };
}

/** Run the full Claude chain (same entry as `hook claude-code`); returns the permissionDecision or "allow". */
async function decide(tool: string, toolInput: Record<string, unknown>): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "fh-wta-home-"));
  const out = await handleHook("claude-code", payload(tool, toolInput), { now: 1000, cwd: root, home }).finally(() => rmSync(home, { recursive: true, force: true }));
  if (!out.stdout) return "allow";
  const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  return parsed.hookSpecificOutput?.permissionDecision ?? "allow";
}

const multi = (file: string, newString: string): Record<string, unknown> => ({ file_path: file, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: newString }] });
const notebook = (file: string, src: string): Record<string, unknown> => ({ notebook_path: file, new_source: src, cell_id: "c1", edit_mode: "replace" });

describe("normalizeEvent: MultiEdit / NotebookEdit are file writes", () => {
  test("NotebookEdit -> Edit-shaped event with notebook_path and new_source", () => {
    const e = normalizeEvent("claude-code", payload("NotebookEdit", notebook("/p/a.ipynb", "print(1)")));
    expect(e.tool).toBe("Edit");
    expect(e.filePath).toBe("/p/a.ipynb");
    expect(e.content).toBe("print(1)");
  });

  test("MultiEdit -> Edit-shaped event, content = every new_string", () => {
    const e = normalizeEvent("claude-code", payload("MultiEdit", multi("/p/a.ts", "NEW")));
    expect(e.tool).toBe("Edit");
    expect(e.filePath).toBe("/p/a.ts");
    expect(e.content).toContain("b");
    expect(e.content).toContain("NEW");
  });

  test("single-edit MultiEdit keeps old_string (size gate = Edit); several edits stay fail-closed", () => {
    const one = normalizeEvent("claude-code", payload("MultiEdit", { file_path: "/p/a.ts", edits: [{ old_string: "a", new_string: "b" }] }));
    expect(one.oldString).toBe("a");
    expect(normalizeEvent("claude-code", payload("MultiEdit", multi("/p/a.ts", "NEW"))).oldString).toBeUndefined();
  });

  test("Write / Edit / Agent / Task keep their names", () => {
    expect(normalizeEvent("claude-code", payload("Write", { file_path: "/p/a.ts", content: "x" })).tool).toBe("Write");
    expect(normalizeEvent("claude-code", payload("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" })).tool).toBe("Edit");
    expect(normalizeEvent("claude-code", payload("Agent", { prompt: "p", description: "d", subagent_type: "Explore" })).tool).toBe("Agent");
    expect(normalizeEvent("claude-code", payload("Task", { prompt: "p", description: "d" })).tool).toBe("Task");
  });

  test("a MultiEdit payload with malformed edits never throws", () => {
    for (const edits of [undefined, null, 7, "x", [null, 3, { new_string: 9 }]]) {
      expect(() => normalizeEvent("claude-code", payload("MultiEdit", { file_path: "/p/a.ts", edits }))).not.toThrow();
    }
  });
});

describe("chain: protected path is blocked for every write tool", () => {
  test("Write and Edit (baseline)", async () => {
    expect(await decide("Write", { file_path: PROTECTED, content: "{}" })).toBe("deny");
    expect(await decide("Edit", { file_path: PROTECTED, old_string: "a", new_string: "b" })).toBe("deny");
  });

  test("MultiEdit is blocked like Edit", async () => {
    expect(await decide("MultiEdit", multi(PROTECTED, "{}"))).toBe("deny");
  });

  test("NotebookEdit is blocked like Edit", async () => {
    expect(await decide("NotebookEdit", notebook(PROTECTED.replace("hooks.json", "n.ipynb"), "x=1"))).toBe("deny");
  });
});

describe("chain: Agent (current name) is handled exactly like Task (legacy alias)", () => {
  test("same decision for the same spawn payload (a decision-time lesson note may differ: it is keyed on the literal tool name)", async () => {
    for (const spawn of [
      { prompt: "do it", description: "d", subagent_type: "general-purpose", name: "x" },
      { prompt: "OWNER RULES / WRITE / OUTPUT", description: "d", subagent_type: "fuse-ai-pilot:sniper" },
    ]) {
      expect(await decide("Agent", spawn)).toBe(await decide("Task", spawn));
    }
  });
});

describe("adapters/claude guard() (library entry) covers the same tools", () => {
  test("NotebookEdit and MultiEdit on a protected path are denied", () => {
    const nb = guard({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: notebook(PROTECTED, "x") as never });
    const me = guard({ hook_event_name: "PreToolUse", tool_name: "MultiEdit", tool_input: multi(PROTECTED, "x") as never });
    expect(nb).not.toBeNull();
    expect(me).not.toBeNull();
  });
});

describe("chain: parity with Edit on code files and plain paths", () => {
  test("MultiEdit decision equals the Edit decision (code file, small and huge)", async () => {
    for (const body of ["const z = 1;", HUGE]) {
      const edit = await decide("Edit", { file_path: BIG, old_string: "a", new_string: body });
      expect(await decide("MultiEdit", multi(BIG, body))).toBe(edit);
    }
  });

  test("NotebookEdit decision equals the Edit decision on a plain notebook path", async () => {
    const nb = join(root, "nb.ipynb");
    const edit = await decide("Edit", { file_path: nb, old_string: "a", new_string: "x=1" });
    expect(await decide("NotebookEdit", notebook(nb, "x=1"))).toBe(edit);
  });
});

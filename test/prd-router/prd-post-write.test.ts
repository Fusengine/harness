import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "../../src/runtime/normalize";
import { derivePostWrite } from "../../src/runtime/prd/prd-post-write";

const FILE = ".codex/apex/prd.json";
/** Text-or-null view of {@link derivePostWrite} (deleted / unknown -> null). */
function derivePostWriteText(event: ReturnType<typeof normalizeEvent>, file: string, current: string | null): string | null {
  const cmd = event.input.command;
  const r = derivePostWrite({ event, patch: typeof cmd === "string" ? cmd : "", isTarget: (p) => p === file, current });
  return r.state === "text" ? r.text : null;
}
const patch = (body: string): ReturnType<typeof normalizeEvent> =>
  normalizeEvent("codex", { hook_event_name: "PreToolUse", tool_name: "apply_patch", session_id: "s", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });
const claude = (tool: string, input: Record<string, unknown>): ReturnType<typeof normalizeEvent> =>
  normalizeEvent("claude-code", { hook_event_name: "PreToolUse", tool_name: tool, session_id: "s", tool_input: input });

describe("derivePostWriteText: Claude Code Write / Edit", () => {
  test("Write returns its content (even empty); needs no current text", () => {
    expect(derivePostWriteText(claude("Write", { file_path: FILE, content: "{}" }), FILE, null)).toBe("{}");
    expect(derivePostWriteText(claude("Write", { file_path: FILE, content: "" }), FILE, null)).toBe("");
  });

  test("Edit: unique match replaced; absent, ambiguous or missing current -> null; replace_all replaces every match", () => {
    const e = (old: string, neu: string, all?: boolean) => claude("Edit", { file_path: FILE, old_string: old, new_string: neu, ...(all ? { replace_all: true } : {}) });
    expect(derivePostWriteText(e("b", "X"), FILE, "abc")).toBe("aXc");
    expect(derivePostWriteText(e("z", "X"), FILE, "abc")).toBeNull();
    expect(derivePostWriteText(e("a", "X"), FILE, "aba")).toBeNull();
    expect(derivePostWriteText(e("a", "X", true), FILE, "aba")).toBe("XbX");
    expect(derivePostWriteText(e("a", "X"), FILE, null)).toBeNull();
  });

  test("any other tool (e.g. MultiEdit) is not derivable", () => {
    expect(derivePostWriteText(claude("MultiEdit", { file_path: FILE, edits: [] }), FILE, "x")).toBeNull();
  });
});

describe("derivePostWriteText: Codex apply_patch", () => {
  const upd = (hunks: string) => patch(`*** Update File: ${FILE}\n${hunks}`);

  test("Add File returns the added text", () => {
    expect(derivePostWriteText(patch(`*** Add File: ${FILE}\n+{"a":1}`), FILE, null)).toBe('{"a":1}');
  });

  test("Update: exactly ONE chunk is derived; several chunks are unknown", () => {
    expect(derivePostWriteText(upd("@@\n-two\n+TWO"), FILE, "one\ntwo\nthree\n")).toBe("one\nTWO\nthree\n");
    expect(derivePostWriteText(upd("@@\n-one\n+ONE\n@@\n-three\n+THREE"), FILE, "one\ntwo\nthree\n")).toBeNull();
  });

  test("final newline pair: Codex always writes a final newline (present or not in the original)", () => {
    expect(derivePostWriteText(upd("@@\n-two\n+TWO"), FILE, "one\ntwo\nthree")).toBe("one\nTWO\nthree\n");
    expect(derivePostWriteText(upd("@@\n-two\n+TWO"), FILE, "one\ntwo\nthree\n")).toBe("one\nTWO\nthree\n");
  });

  test("b01/b02: a chunk with a blank (empty) old/new line is unknown, even with a trailing newline and duplicate lines", () => {
    const file = '{"a": {"y": 1\n}}\n, "u": {"m": 1\n}}\n';
    expect(derivePostWriteText(upd("@@\n-}}\n+}}}\n "), FILE, file)).toBeNull(); // b01: empty context line
    expect(derivePostWriteText(upd('@@\n-}}\n+}}\n+, "k": 1\n '), FILE, file)).toBeNull(); // b02
    expect(derivePostWriteText(upd("@@\n-}}\n+}}}"), FILE, file)).toBeNull(); // duplicate '}}' -> ambiguous
  });

  test("pure deletion drops the whole line; pure add is unknown", () => {
    expect(derivePostWriteText(upd("@@\n-two"), FILE, "one\ntwo\nthree\n")).toBe("one\nthree\n");
    expect(derivePostWriteText(upd("@@\n+four"), FILE, "one\n")).toBeNull();
  });

  test("uncertain cases -> null: chunk not found, ambiguous, overlapping, Delete File, Move to, no current text", () => {
    expect(derivePostWriteText(upd("@@\n-zzz\n+y"), FILE, "one\n")).toBeNull();
    expect(derivePostWriteText(upd("@@\n-a\n+y"), FILE, "a\nb\na\n")).toBeNull();
    expect(derivePostWriteText(upd("@@\n-a\n-b\n+y\n@@\n-b\n+z"), FILE, "a\nb\n")).toBeNull();
    expect(derivePostWriteText(patch(`*** Delete File: ${FILE}`), FILE, "x")).toBeNull();
    expect(derivePostWriteText(upd(`*** Move to: other.json\n@@\n-one\n+ONE`), FILE, "one\n")).toBeNull();
    expect(derivePostWriteText(upd("@@\n-one\n+ONE"), FILE, null)).toBeNull();
  });

  test("two Update blocks on the same file apply in order; other files in the envelope are ignored", () => {
    const ev = patch(`*** Update File: ${FILE}\n@@\n-a\n+b\n*** Add File: x.txt\n+hi\n*** Update File: ${FILE}\n@@\n-b\n+c`);
    expect(derivePostWriteText(ev, FILE, "a\n")).toBe("c\n");
  });

  // Codex seeks chunk N from the end of chunk N-1 and falls back to trim/rstrip matching when no exact
  // line follows, so out-of-order chunks are not reproducible here (challenger k01/k05).
  const TWIN = '{"t": {"status":\n"in_progress"\n}, "u": {"n":\n  "in_progress"\n}}\n';
  const U = '}, "u": {"n":';

  test("k01/k05: out-of-order chunks (later chunk's exact line lies before the earlier chunk) -> unknown", () => {
    const outOfOrder = upd(`@@\n-${U}\n+${U}\n@@\n-"in_progress"\n+"in-progress"`);
    expect(derivePostWriteText(outOfOrder, FILE, TWIN.replace('\n}, "u": {"n":', `\n${U}`))).toBeNull();
  });

  test("k02/k04 controls: in-order chunks and a single chunk resolve without a twin, and are unknown with one (whole-file rule)", () => {
    const plain = `{"t": {"status":\n"in_progress"\n${U}\n"x"\n}}\n`;
    const fixed = plain.replace('\n"in_progress"\n', '\n"in-progress"\n');
    expect(derivePostWriteText(upd('@@\n-"in_progress"\n+"in-progress"'), FILE, plain)).toBe(fixed);
    expect(derivePostWriteText(upd(`@@\n-"in_progress"\n+"in-progress"\n@@\n-${U}\n+${U}`), FILE, plain)).toBeNull(); // several chunks
    const twin = `{"t": {"status":\n"in_progress"\n${U}\n  "in_progress"\n}}\n`;
    expect(derivePostWriteText(upd('@@\n-"in_progress"\n+"in-progress"'), FILE, twin)).toBeNull();
    expect(derivePostWriteText(upd(`@@\n-"in_progress"\n+"in-progress"\n@@\n-${U}\n+${U}`), FILE, twin)).toBeNull();
  });

  test("n04: an Update carrying '*** End of File' (Codex anchors at EOF) -> unknown", () => {
    expect(derivePostWriteText(upd("@@\n-two\n+TWO\n*** End of File"), FILE, "one\ntwo\nthree\n")).toBeNull();
  });

  test("a whitespace / Unicode twin ANYWHERE in the file, in any comparison mode, -> unknown; no twin -> resolves", () => {
    const patchTwo = upd("@@\n-two\n+TWO");
    expect(derivePostWriteText(patchTwo, FILE, "one\ntwo\nthree\n")).toBe("one\nTWO\nthree\n");
    for (const twin of ["two  ", "  two", "\ttwo\t", "two "]) {
      expect(derivePostWriteText(patchTwo, FILE, `one\ntwo\n${twin}\nthree\n`)).toBeNull(); // twin after
      expect(derivePostWriteText(patchTwo, FILE, `${twin}\none\ntwo\nthree\n`)).toBeNull(); // twin before
    }
    const quoted = upd('@@\n-"q"\n+"r"');
    expect(derivePostWriteText(quoted, FILE, 'a\n"q"\nb\n')).toBe('a\n"r"\nb\n');
    expect(derivePostWriteText(quoted, FILE, 'a\n"q"\nb\n“q”\n')).toBeNull();
  });

  test("a file absent from the envelope -> null", () => {
    expect(derivePostWriteText(patch("*** Add File: x.txt\n+hi"), FILE, "x")).toBeNull();
  });
});

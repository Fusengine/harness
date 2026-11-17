/**
 * @module write-tool-aliases
 * Claude Code file-write tools that are not named `Write` / `Edit` — `MultiEdit`
 * (`file_path` + `edits[]`, older builds) and `NotebookEdit` (`notebook_path` +
 * `new_source`) — carry their target in fields the generic normalizer does not
 * read. Every gate keys on `tool === "Write" | "Edit"` plus `filePath`, so these
 * calls used to pass the whole chain unseen (fail-open). This maps them onto an
 * Edit-shaped event so protected-path, size, DRY and interface gates judge them
 * like an `Edit`.
 *
 * Fail-closed shape: `oldString` stays undefined, so the file-size gate falls back
 * to the stale on-disk count (see `computeEditResultLines`), never an allow.
 */

/** Edit-shaped view of a non-standard write tool. */
export interface AliasedWrite {
  /** Canonical tool name every gate already understands. */
  tool: "Edit";
  /** Target file (`file_path` or `notebook_path`). */
  filePath: string | undefined;
  /** Incoming text: every `new_string` of a MultiEdit, or the notebook `new_source`. */
  content: string | undefined;
  /** `old_string` of a single-edit MultiEdit; undefined for several edits (fail-closed) and for NotebookEdit. */
  oldString?: string | undefined;
  /** Tool input, with `replace_all: true` lifted when any MultiEdit edit sets it (so the trivial-edit fast path stays closed). */
  input: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The well-formed entries of a MultiEdit `edits` array; anything else is ignored. */
function editsOf(input: Record<string, unknown>): Record<string, unknown>[] {
  const edits = input.edits;
  if (!Array.isArray(edits)) return [];
  return edits.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
}

/**
 * Map `MultiEdit` / `NotebookEdit` onto an Edit-shaped event.
 * @param tool - The wire `tool_name`.
 * @param input - The wire `tool_input`.
 * @returns The aliased write, or `null` for every other tool (callers keep the generic path).
 */
export function canonicalizeWriteTool(tool: string, input: Record<string, unknown>): AliasedWrite | null {
  if (tool === "NotebookEdit") {
    return { tool: "Edit", filePath: str(input.notebook_path) ?? str(input.file_path), content: str(input.new_source), input };
  }
  if (tool === "MultiEdit") {
    const edits = editsOf(input);
    const news = edits.map((e) => str(e.new_string)).filter((s): s is string => s !== undefined);
    const replaceAll = edits.some((e) => e.replace_all === true);
    const only = edits.length === 1 ? edits[0] : undefined;
    return {
      tool: "Edit",
      filePath: str(input.file_path),
      content: news.length > 0 ? news.join("\n") : undefined,
      // A single-edit MultiEdit IS an Edit: keep its old_string so the size gate computes the real post-edit outcome (no stricter than Edit).
      oldString: only ? str(only.old_string) : undefined,
      input: replaceAll ? { ...input, replace_all: true } : input,
    };
  }
  return null;
}

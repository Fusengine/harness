/** The user turn Claude Code queues for a finished background agent (shape captured from a real lead session, v2.1.317-319). */
export const notification = (taskId: string, result: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_018CGqDRnpf3pFsHaG2KjxGV</tool-use-id>\n<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Agent "d" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>${result}</result>\n</task-notification>`;

/** A UserPromptSubmit payload for the test session `s`. */
export const ups = (prompt: string): Record<string, unknown> => ({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt });

import { attachSystemMessage } from "../adapters/claude";
import { designPassNotice } from "../policy/design/gates";
import { refCreditNoticeFor } from "./notices";
import { projectStateDir } from "./project-state-dir";
import { respond } from "./respond";
import type { Activity } from "./record";
import type { HandleOutcome } from "./handle";
import type { NormalizedEvent } from "./normalize";
import { formatPrompt, type Prompt } from "../prompt/types";

/** Extract the additional-context body from a Claude-shaped post response. */
export function additionalContextOf(stdout: string): string {
  if (!stdout) return "";
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
}

function cursorPostToolOutput(eventName: string, designWarn: Prompt | null, userMessage: string | undefined, extra: string): string {
  if (!/^postToolUse$/i.test(eventName)) return "";
  const context = [designWarn ? formatPrompt(designWarn) : "", designWarn?.userMessage, userMessage, additionalContextOf(extra)]
    .filter(Boolean)
    .join("\n");
  return context ? JSON.stringify({ additional_context: context }) : "";
}

/**
 * Assemble the final PostToolUse response after all side effects and deny paths.
 * @param input - Final assembly values captured at their original evaluation times.
 * @returns The native hook outcome.
 */
export function postOutcome(input: {
  id: string; agentId: string; sessionId: string; now: number; cwd: string;
  activities: readonly Activity[]; files: readonly NormalizedEvent[];
  designCacheDir: string; designWarn: Prompt | null; extra: string;
  cursorAfterFileEdit: boolean; cursorEventName: string;
}): HandleOutcome {
  const { id, agentId, sessionId, now, cwd, activities, files, designCacheDir, designWarn, extra, cursorAfterFileEdit, cursorEventName } = input;
  const noticeLines: string[] = [];
  for (const f of files) {
    const notice = designPassNotice({ agentId, tool: f.tool, filePath: f.filePath ?? "", content: f.content ?? "", url: "", phase: "post" }, designCacheDir);
    if (notice?.userMessage) noticeLines.push(notice.userMessage);
  }
  const notice: Prompt | null = noticeLines.length ? { kind: "inform", title: "Design pipeline", reason: "", userMessage: noticeLines.join("\n") } : null;
  const refNotice = refCreditNoticeFor(activities, sessionId, now, projectStateDir(cwd));
  const userMessage = [notice?.userMessage, refNotice].filter(Boolean).join("\n") || undefined;
  // Cursor ignores callback fields for afterFileEdit; complete successfully
  // without emitting the permission schema reserved for pre-execution hooks.
  if (cursorAfterFileEdit) return { stdout: "{}", exit: 0 };
  if (id === "cursor") return { stdout: cursorPostToolOutput(cursorEventName, designWarn, userMessage, extra), exit: 0 };
  if (designWarn) return { stdout: respond(id, userMessage ? { ...designWarn, userMessage } : designWarn, "PostToolUse"), exit: 0 };
  if (!userMessage) return { stdout: extra, exit: 0 };
  const withUserMessage: Prompt = notice ? { ...notice, userMessage } : { kind: "inform", title: "Compliance", reason: "", userMessage };
  if (!extra) return { stdout: respond(id, withUserMessage, "PostToolUse"), exit: 0 };
  if (id === "claude-code" || id === "codex") return { stdout: attachSystemMessage(extra, userMessage), exit: 0 };
  if (id === "kimi") return { stdout: respond(id, withUserMessage, "PostToolUse"), exit: 0 };
  return { stdout: respond(id, withUserMessage, "PostToolUse") || extra, exit: 0 };
}

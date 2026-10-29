/**
 * @module motion/self-approval
 * Block every agent write path into the harness-owned motion store
 * (`~/.fuse-harness/motion/`): the agent must never forge an approval.
 */
import { motionShellWriteTargets } from "./shell-targets";
import type { Prompt } from "../../prompt/types";
import { LEGACY_MOTION_FRAGMENT, MOTION_STORE_FRAGMENT } from "./store";
import { commandTokens, expansionText, hasSubstitution, segmentVerb, shellSegments } from "./shell-verbs";
import { globToRe } from "../../refs/frontmatter";
import { canonicalFilePath } from "../../runtime/prd/prd-canon";
import { MOTION_WRITE_TOOLS } from "./constants";
import { homedir } from "node:os";
import { homePath } from "./command-context";

/** Harmless verbs next to the store (`cd` and pure filters change nothing on disk). */
const READ_VERBS = new Set(["cat", "ls", "stat", "head", "tail", "wc", "file", "jq", "grep", "cd", "sort", "uniq"]);
const DESTRUCTIVE = new Set(["rm", "mv", "chmod", "chown", "rmdir", "unlink"]);
const HARNESS_DIR = ".fuse-harness";
/** The Motion root directory name; a command that does not name it (or the legacy store) cannot target the store. */
const STORE_DIR = "video-motion";
/** The text names the Motion store: current fragment or a leftover pre-relocation `.fuse-harness/motion` directory. */
const inStore = (text: string): boolean => text.includes(MOTION_STORE_FRAGMENT) || text.includes(LEGACY_MOTION_FRAGMENT);
/** The command targets the approval store: it names `motion` or `approvals` (case-insensitive). */
const STORE_HINT = /motion|approvals/i;
/** A token that is the harness directory itself (`~/.fuse-harness`, `$HOME/.fuse-harness/`). */
const isHarnessRoot = (t: string): boolean => /(?:^|\/)\.fuse-harness\/*$/.test(norm(t));

const norm = (p: string): string => p.replace(/\\/g, "/");

/** A normalized hidden home path could expand to the harness store. */
function dynamicHarnessPath(command: string): boolean {
  return [...command.matchAll(/(?:~|\$HOME|\$\{HOME\})\/([^\s;|&]*)/g)].some((m) => {
    // Empty and dot components do not change lookup; keep '..' because symlinks can affect it.
    const path = (m[1] ?? "").split("/").filter((part) => part !== "" && part !== ".").join("/");
    if (!path.startsWith(".")) return false;
    if (!/[*?[$]/.test(path)) return false;
    const parts = path.split("/");
    const root = (parts[0] ?? "").replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "*");
    // A literal harness root only matters when the next component can still select the Motion root.
    if (root === HARNESS_DIR) return ambiguousMatch((parts[1] ?? "*").replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "*"), STORE_DIR);
    return ambiguousMatch(root, HARNESS_DIR);
  });
}

/** Can the (possibly glob) component `pattern` select `name`? Complex bracket patterns are ambiguous; simple globs reuse the shared matcher. */
function ambiguousMatch(pattern: string, name: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern.toLowerCase() === name.toLowerCase();
  return pattern.includes("[") ? name.startsWith(pattern.split(/[*?[]/)[0] ?? "") : globToRe(pattern.replace(/\?/g, "*")).test(name);
}

function block(detail: string): Prompt {
  return {
    kind: "block",
    title: "Motion self-approval guard",
    reason: `The motion approval store (~/${MOTION_STORE_FRAGMENT}/) is owned by the harness and cannot be modified by an agent (${detail}). Approvals come only from the owner typing MOTION-APPROVE <stage> <code>.`,
  };
}

/**
 * Detect an agent attempt to write the motion approval store.
 * @param tool - Tool name (`Write`, `Bash`, ...).
 * @param filePath - `tool_input.file_path`, if any.
 * @param command - `tool_input.command`, if any.
 * @returns A block prompt, or `null` when the call does not touch the store.
 */
export function selfApprovalViolation(tool: string, filePath: string | undefined, command: string | undefined, cwd: string = process.cwd(), home: string = homedir()): Prompt | null {
  if (MOTION_WRITE_TOOLS.has(tool)) return filePath && [filePath, canonicalFilePath(homePath(filePath, cwd, home))].some((p) => inStore(norm(p))) ? block(`${tool} on ${filePath}`) : null;
  if (tool !== "Bash" || !command) return null;
  const joined = expansionText(command);
  const targets = [...motionShellWriteTargets(command), ...motionShellWriteTargets(joined)];
  if (targets.some((t) => [t, canonicalFilePath(homePath(t, cwd, home))].some((p) => inStore(norm(p))))) return block("write target inside the store");
  const segs = shellSegments(command);
  if (segs.some((s) => segmentVerb(s) === "ln" && commandTokens(s).some((t) => norm(t).includes(HARNESS_DIR)))) return block("link into harness state");
  if (/\bcd\s+(?:~|\$HOME)/.test(command) && segs.some((s) => /^(?:tar|unzip|ditto)$/.test(segmentVerb(s)))) return block("archive extraction under the home directory");
  if (/video-mo|\.fuse-har[A-Za-z-]*[*?[$]/i.test(joined) && targets.length > 0) return block("ambiguous harness write");
  if (dynamicHarnessPath(joined) && (targets.length > 0 || hasSubstitution(command) || segs.some((s) => !READ_VERBS.has(segmentVerb(s))))) return block("hidden home path next to a writer");
  if (!command.includes(HARNESS_DIR) && !joined.includes(HARNESS_DIR)) return null;
  if ([...segs, ...shellSegments(joined)].some((s) => DESTRUCTIVE.has(segmentVerb(s)) && commandTokens(s).some(isHarnessRoot))) return block("destroying the harness directory");
  if (!inStore(command) && !inStore(joined) && !command.toLowerCase().includes(STORE_DIR) && !joined.toLowerCase().includes(STORE_DIR)) return null;
  if (!STORE_HINT.test(command) && !STORE_HINT.test(joined)) return null;
  if (hasSubstitution(command)) return block("command substitution next to the harness directory");
  const writer = segs.find((s) => !READ_VERBS.has(segmentVerb(s)));
  return writer ? block("a non read-only command mentions the harness motion store") : null;
}

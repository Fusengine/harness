import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { isTempOnlyDelete } from "./security-temp-delete";
import { remoteLocalView } from "../remote-target";

/** Label of the system-directory delete block; the only one the temp-dir narrowing lifts. */
const SYSTEM_DIR_LABEL = "DANGEROUS PATTERN: recursive delete of a system directory";
/** Pattern of the system-directory delete block (shared by CRITICAL_PATTERNS and the temp-dir narrowing). */
const SYSTEM_DIR_RE = /\brm\s+(?:-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*\/(?:etc|usr|var|bin|sbin|boot|lib)\b/;

/**
 * Labels that only describe THIS machine (privilege escalation, system-directory delete, /etc write, plain rm, recursive
 * chown, chmod 777): they give no opinion on a PROVEN-remote ssh payload. Every other label (mkfs, dd, fork bomb, rm -rf /,
 * remote script piped to a shell, ...) keeps firing on the whole command.
 */
const REMOTE_RELAXED: ReadonlySet<string> = new Set([
  SYSTEM_DIR_LABEL, "PRIVILEGE ESCALATION: sudo", "PRIVILEGE ESCALATION: su", "PRIVILEGE ESCALATION: doas", "PRIVILEGE ESCALATION: passwd",
  "DANGEROUS PATTERN: recursive chown", "DANGEROUS PATTERN: chmod 777", "DANGEROUS PATTERN: write to /etc",
  "DELETE: 'rm' permanently deletes - confirmation required",
]);

/** A pattern paired with the violation label to name in the deny/ask reason. */
export interface LabeledPattern {
  re: RegExp;
  label: string;
}

/** Critical patterns that must always be blocked — parity `security_rules.py`'s cumulated violation names. */
export const CRITICAL_PATTERNS: LabeledPattern[] = [
  { re: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*(?:\/|~)(?:\s|$)/, label: "DANGEROUS PATTERN: recursive delete of / or ~" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: "DANGEROUS PATTERN: fork bomb" },
  { re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, label: "DANGEROUS PATTERN: remote script piped to a shell" },
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\//, label: "DANGEROUS PATTERN: chmod 777 on /" },
  { re: /\bmkfs(?:\.[a-z0-9]+)?\b/, label: "CRITICAL: Detected dangerous command 'mkfs'" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(?:r?disk|sd|hd|nvme|mmcblk|vd|xvd)/i, label: "CRITICAL: Detected dangerous command 'dd if='" },
  { re: /\bshred\b/, label: "CRITICAL: Detected dangerous command 'shred'" },
  { re: /\bfdisk\b/, label: "CRITICAL: Detected dangerous command 'fdisk'" },
  { re: /\bdiskutil\s+(?:erase|partitionDisk)/i, label: "CRITICAL: Detected dangerous command 'diskutil erase'" },
  { re: /(?:>|>>)\s*\/dev\/(?:sda|hda|nvme)/, label: "DANGEROUS PATTERN: redirect to a raw disk device" },
  { re: SYSTEM_DIR_RE, label: SYSTEM_DIR_LABEL },
  // Privilege escalation — DENY (parity: security_rules.PRIVILEGE_COMMANDS, has_critical=True).
  { re: /(?:^|[\s;|&])sudo(?:[\s;|&]|$)/, label: "PRIVILEGE ESCALATION: sudo" },
  { re: /(?:^|[\s;|&])su(?:[\s;|&]|$)/, label: "PRIVILEGE ESCALATION: su" },
  { re: /(?:^|[\s;|&])doas(?:[\s;|&]|$)/, label: "PRIVILEGE ESCALATION: doas" },
  { re: /(?:^|[\s;|&])passwd(?:[\s;|&]|$)/, label: "PRIVILEGE ESCALATION: passwd" },
  // `del` — DENY (parity: security_rules.CRITICAL_COMMANDS token match).
  { re: /(?:^|[\s;|&])del(?:[\s;|&]|$)/, label: "CRITICAL: Detected dangerous command 'del'" },
];

/** Patterns that warrant explicit confirmation before running — parity `security_rules.py`'s ask-level violation names. */
export const ASK_PATTERNS: LabeledPattern[] = [
  { re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, label: "DANGEROUS PATTERN: chmod 777" },
  { re: /\bchown\s+-R\b/, label: "DANGEROUS PATTERN: recursive chown" },
  { re: /\beval\s/, label: "DANGEROUS PATTERN: eval" },
  { re: /(?:>|>>|\btee\b)\s*\/etc\//, label: "DANGEROUS PATTERN: write to /etc" },
  { re: /\brm\s/, label: "DELETE: 'rm' permanently deletes - confirmation required" },
  { re: /\bunlink\s/, label: "DELETE: 'unlink' command detected - confirmation required" },
];

/**
 * Strip heredoc bodies so their content isn't matched as a command (false positives).
 * Two-phase scan: a backreference-free opener regex finds `<<[-]DELIM`, then the body
 * is cut up to the closing delimiter via `indexOf` — O(n), no catastrophic backtracking.
 */
function stripHeredoc(cmd: string): string {
  const opener = /<<-?\s*['"]?(\w+)['"]?/g;
  let out = cmd;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(out)) !== null) {
    const delim: string = m[1] ?? "";
    // Closer may be indented (the `<<-` form strips leading tabs); `\b` ends the word.
    const closer = new RegExp(`\\n[ \\t]*${delim}\\b`);
    const rest: string = out.slice(m.index + m[0].length);
    const hit: RegExpMatchArray | null = closer.exec(rest);
    if (!hit || hit.index === undefined) break;
    const end: number = m.index + m[0].length + hit.index + hit[0].length;
    out = `${out.slice(0, m.index)} ${out.slice(end)}`;
    opener.lastIndex = m.index;
  }
  return out;
}

/**
 * Guards against dangerous Bash commands. Parity `security_rules.validate_command`
 * + `security-guard.py`: ACCUMULATE every matched violation, then deny when any
 * critical matched else ask, joining all violation labels in the reason. The
 * generic `rm` ask is exempt when the command targets a trash location (parity
 * `not re.search('trash', cmd)`).
 */
export function securityGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  const cmd: string = stripHeredoc(ctx.command);
  // A plain `rm` of temp-dir children only (judged on the RAW command, so any heredoc keeps main's verdict): the
  // system-directory block steps aside for the rm ask, which is then never trash-exempt. Otherwise identical to main.
  const lifted: boolean = SYSTEM_DIR_RE.test(cmd) && isTempOnlyDelete(ctx.command);
  const hasTrash: boolean = !lifted && /trash/i.test(cmd);

  // PROVEN-remote ssh payloads are cut out of the local view: a relaxable rule that fires only on the payload steps aside.
  // The view is matched raw (never heredoc-stripped): a stray `<<'EOF'` operator left in it could otherwise pair with a later local
  // line and hide it. Matching more text can only keep more of today's hits, never fewer.
  const local: string | null = remoteLocalView(ctx.command);
  const offLocal = ({ re, label }: LabeledPattern): boolean => local !== null && REMOTE_RELAXED.has(label) && !re.test(local);

  const critical: string[] = CRITICAL_PATTERNS.filter((p) => p.re.test(cmd) && !(lifted && p.label === SYSTEM_DIR_LABEL) && !offLocal(p)).map((p) => p.label);
  const ask: string[] = ASK_PATTERNS.filter(
    (p) => p.re.test(cmd) && !(hasTrash && p.label.startsWith("DELETE: 'rm'")) && !offLocal(p),
  ).map((p) => p.label);
  if (critical.length === 0 && ask.length === 0) return null;

  if (critical.length > 0) {
    return {
      kind: "block",
      title: "Dangerous command",
      reason: `${[...critical, ...ask].join(", ")}.`,
      actions: ["Remove the destructive command", "Scope the operation to a specific safe path"],
    };
  }
  return {
    kind: "ask",
    title: "Dangerous command",
    reason: `${ask.join(", ")}.`,
    actions: ["Confirm this command is intended", "Run with least privilege"],
  };
}

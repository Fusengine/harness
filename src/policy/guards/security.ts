import type { Prompt } from "../../prompt/types";
import type { GuardContext } from "./context";
import { isTempOnlyDelete } from "./security-temp-delete";
import { remoteLocalView } from "../remote-target";
import { isProvenLocalDest } from "../remote-target-host";
import { scanShell } from "../remote-target-scan";
import { parseSsh } from "../remote-target-ssh";
import { isTrashDelete } from "./security-trash";
import { RM_ROOT_LABEL, isLiteralOperand, rmOperands, rmTargetsRoot } from "./security-rm-root";
import { expand } from "../effective-segments";

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
 * Whether `raw` starts with ONE simple `ssh [options] host …` line fed by a heredoc whose literal host is NOT proven local (loopback /
 * own name or address / a lookup returning a local address; a failed or timed-out lookup is no proof). False when anything is unreadable.
 * @param raw - Raw Bash command.
 */
function sshHeredocToNonLocal(raw: string): boolean {
  const at = raw.indexOf("<<");
  if (at < 0) return false;
  const segs = scanShell(raw.slice(0, at));
  const seg = segs && segs.length === 1 ? segs[0] : undefined;
  const first = seg?.words[0];
  if (!seg || !first || first.dynamic || !/^(?:\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/)?ssh$/.test(first.text)) return false;
  const dest = parseSsh(seg.words)?.dest;
  return dest !== undefined && !dest.dynamic && !isProvenLocalDest(dest.text);
}

/**
 * Guards against dangerous Bash commands. Parity `security_rules.validate_command`
 * + `security-guard.py`: ACCUMULATE every matched violation, then deny when any
 * critical matched else ask, joining all violation labels in the reason. Every
 * pattern is also matched against each command the line really runs behind a
 * wrapper (`sh -c '…'`, `cd x &&`, `( … )`, `$(…)`; see `expand`), so a wrapper
 * never weakens a verdict. The generic `rm` ask is waived only when every `rm`
 * the line runs deletes inside a trash directory (never for the bare word
 * "trash"; `mv x ~/.Trash/` is no `rm` and stays allowed).
 */
export function securityGuard(ctx: GuardContext): Prompt | null {
  if (ctx.tool !== "Bash" || !ctx.command) return null;
  const cmd: string = stripHeredoc(ctx.command);
  // A plain `rm` of temp-dir children only (judged on the RAW command, so any heredoc keeps main's verdict): the
  // system-directory block steps aside for the rm ask, which is then never trash-exempt. Otherwise identical to main.
  const raw: string = ctx.command;
  // PROVEN-remote ssh payloads are cut out of the local view: every REMOTE_RELAXED label (and the rm-root refusal) is judged on
  // that view only, so a payload-only hit steps aside; all other labels keep firing on the whole command. The view is matched
  // raw (never heredoc-stripped): a stray `<<'EOF'` operator left in it could otherwise pair with a later local line and hide it.
  const local: string | null = remoteLocalView(raw);
  // Canonical text (quotes resolved) only for the verbs the rm / unlink patterns are about: `grep -n "rm" f` is no rm.
  const textsOf = (src: string, head: string) => {
    const { items } = expand(src);
    const texts: string[] = [head, ...items.flatMap((i) => (i.verb === "rm" && !rmOperands(i.argv).some((o) => isLiteralOperand(i.seg, o)) || i.verb === "unlink" ? [i.text, i.seg] : [i.seg]))];
    return { items, texts, head, raw: src };
  };
  const whole = textsOf(raw, cmd);
  // Only a proven-remote payload is relaxed. A heredoc fed to `ssh` whose literal host is NOT proven local keeps the installed verdict
  // (body read heredoc-stripped: remote configuration is a confirmation at most); any other heredoc (loopback / own / unreadable host)
  // gets the full body-expanded judgment.
  const view = local !== null ? textsOf(local, local) : sshHeredocToNonLocal(raw) ? { ...textsOf(cmd, cmd), raw } : whole;
  // The same narrowing applies to a wrapped / quoted `rm` (judged on its canonical text).
  const liftedText = (s: typeof whole, t: string): boolean => SYSTEM_DIR_RE.test(t) && isTempOnlyDelete(t === s.head ? s.raw : t);
  const lifted: boolean = view.texts.some((t) => liftedText(view, t));
  // New waiver = old one (the word "trash" in the command) AND the precise rule: it can only ever ask where main allowed.
  const hasTrash: boolean = !lifted && /trash/i.test(view.head) && isTrashDelete(view.items);
  const hits = (re: RegExp, label: string): boolean => {
    const s = REMOTE_RELAXED.has(label) ? view : whole;
    return s.texts.some((t) => re.test(t) && !(label === SYSTEM_DIR_LABEL && liftedText(s, t)));
  };

  const critical: string[] = CRITICAL_PATTERNS.filter(({ re, label }) => hits(re, label)).map((p) => p.label);
  const ask: string[] = ASK_PATTERNS.filter(
    ({ re, label }) => hits(re, label) && !(hasTrash && label.startsWith("DELETE: 'rm'")),
  ).map((p) => p.label);
  // Only when no existing critical pattern already names the delete (keeps every existing deny message byte-identical).
  if (critical.length === 0 && rmTargetsRoot(view.items)) critical.push(RM_ROOT_LABEL);
  // An unreadable line (`sh -c "$CMD"`, nesting past the analysis budget) is not judged here: `opaqueShellGuard` asks, last in the chain.
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

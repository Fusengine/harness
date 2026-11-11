import type { ShWord, SshInvocation } from "./interfaces/remote-target";

/** Flags without argument that are allowed: `-t -T -q -v -4 -6 -A` (clusters such as `-tt` / `-vvv` included). */
const FLAGS = new Set("tTqv46A".split(""));
/** The only `-o` keys accepted (decision 22:35): none can redirect the connection or run or write anything locally. */
const SAFE_O = new Set(["port", "user", "identityfile", "stricthostkeychecking", "connecttimeout", "batchmode", "serveraliveinterval"]);

/** Whether an option argument is acceptable: `-p` digits, `-l` a plain user, `-i` a literal file, `-o` an allowlisted key. */
function argOk(opt: string, v: ShWord | undefined): boolean {
  if (!v || (v.dynamic && opt !== "i")) return false; // `-i ~/key` is expanded locally and only read; any other expansion can split into words
  if (opt === "p") return /^\d+$/.test(v.text);
  if (opt === "l") return /^[A-Za-z0-9._-]+$/.test(v.text);
  if (opt === "i") return v.dynamic ? /^~\/[^$*?[{]*$/.test(v.text) : v.text !== "" && !v.text.startsWith("-");
  const key = /^\s*([A-Za-z0-9]+)\s*(?:=|\s)\s*\S/.exec(v.text)?.[1];
  return key !== undefined && SAFE_O.has(key.toLowerCase());
}

/**
 * Parse `ssh [allowlisted options] destination command...` from a segment's argv words (`words[0]` is `ssh`).
 * Allowlist by construction: `-p N`, `-i file`, `-l user`, `-o <fixed safe key>`, `-t -T -q -v -4 -6 -A`; any other
 * option (before the destination, or a dash word right after it), a dynamic destination, or a missing destination or
 * remote command returns null.
 * @param words - Argv words of one simple command.
 */
export function parseSsh(words: ShWord[]): SshInvocation | null {
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w || !w.text.startsWith("-") || w.text === "-") break;
    if (w.dynamic) return null;
    for (let k = 1; k < w.text.length; k++) {
      const o = w.text.charAt(k);
      if (FLAGS.has(o)) continue;
      if (!"pilo".includes(o)) return null;
      const glued = w.text.slice(k + 1);
      if (!argOk(o, glued !== "" ? { ...w, text: glued } : words[i + 1])) return null;
      if (glued === "") i++;
      break;
    }
  }
  const dest = words[i];
  const payload = words.slice(i + 1);
  const p0 = payload[0];
  if (!dest || dest.dynamic || dest.text.startsWith("-") || !p0 || p0.text.startsWith("-")) return null;
  // ssh parses options again after the destination: a first payload word the LOCAL shell expands could become one.
  if (p0.dynamic && /^[$*?[{~]/.test(p0.text)) return null;
  return { dest, payload };
}

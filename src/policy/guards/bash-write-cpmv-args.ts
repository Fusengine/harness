import { plain } from "./bash-write-descend-peel";
import type { WordTok } from "./bash-write-descend-types";

const LONG_WITH_ARG = new Set(["--mode", "--owner", "--group", "--suffix"]);

/**
 * `install -d` (bundled or not) only creates directories. Option letters that take a value (`-B suffix`,
 * `-g group`, `-m mode`, `-o owner`, `-f flags`, `-T tags`) end a bundle: a `d` inside `-Bold` is part of the value.
 * @param args - Words after `install`.
 */
export function installDirsOnly(args: readonly WordTok[]): boolean {
  return args.some((a) => {
    const w = plain(a);
    if (!/^-[A-Za-z]/.test(w)) return false;
    for (const ch of w.slice(1)) { if (ch === "d") return true; if ("BfgmoT".includes(ch)) return false; }
    return false;
  });
}

/** Operands of a cp/mv/install/ln command and its target directory, if any. */
export interface Parsed { operands: WordTok[]; targetDir?: WordTok }

/**
 * Split a cp/mv/install/ln argument list into operands and the target directory
 * (`-t DIR`, `-vt DIR`, `-tDIR`, `--target-directory[=]DIR`); options with a value (`-m 644`, `-S x`) are skipped.
 * @param args - Words after the command name.
 * @returns null when an option is missing its value.
 */
export function parseCpArgs(args: readonly WordTok[]): Parsed | null {
  const operands: WordTok[] = [];
  let targetDir: WordTok | undefined;
  let end = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as WordTok;
    const w = plain(a);
    if (a.dynamic) { operands.push(a); continue; }
    if (!end && w === "--") { end = true; continue; }
    if (!end && w.startsWith("--")) {
      const [name = "", ...val] = w.split("=");
      if (name.length >= 4 && "--target-directory".startsWith(name)) { // GNU accepts any unambiguous prefix (`--target`)
        targetDir = val.length > 0 ? { ...a, value: val.join("=") } : args[++k];
        if (!targetDir) return null;
      } else if (LONG_WITH_ARG.has(name) && val.length === 0) k++;
      continue;
    }
    if (!end && /^-[A-Za-z]/.test(w)) {
      for (let c = 1; c < w.length; c++) {
        const ch = w[c] as string;
        if (ch === "S") { if (/^[.~][^/]*$/.test(plain(args[k + 1]))) k++; break; } // GNU `-S SUFFIX`; macOS `-S` takes no value
        if (!"tmog".includes(ch)) continue; // (`-S`/`-T` differ between macOS and GNU: not read as taking a value, so a swallowed source can never hide)
        const glued = w.slice(c + 1);
        const arg = glued ? { ...a, value: glued } : args[++k];
        if (ch === "t") { if (!arg) return null; targetDir = arg; }
        break;
      }
      continue;
    }
    operands.push(a);
  }
  return { operands, targetDir };
}

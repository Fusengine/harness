import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CODE_NAME } from "./bash-write-cpmv-paths";

/**
 * Most directory entries a tree source is walked through before the guard gives up and asks.
 * Derived from a measurement: `/usr/share/man` has about 3,000 entries and this repo's `node_modules`
 * about 3,250 (a full walk takes ~12 ms); 20,000 is ~6x the largest ordinary asset tree measured and
 * walks in well under 100 ms. Override with `FUSE_CPMV_TREE_MAX` (positive integer).
 */
export function treeMaxEntries(): number {
  const n = Number.parseInt(process.env.FUSE_CPMV_TREE_MAX ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/** Deepest directory level walked (symlinks are never followed, so this only bounds pathological nesting). */
const MAX_DEPTH = 40;

/** Shell glob (`*`, `?`, `[set]`) of ONE path component as a regular expression. */
function globRegExp(pat: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i] as string;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") { const e = pat.indexOf("]", i + 2); if (e < 0) re += "\\["; else { re += `[${pat.slice(i + 1, e).replace(/^!/, "^")}]`; i = e; } }
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** What a directory tree holds, as far as a bounded read can tell. */
export type TreeContent = "clean" | "code" | "unknown";

/**
 * Inspect what a glob in the LAST path component (`dir/*`, `dir/*.png`) matches on disk: a matched file
 * with a code name is code, a matched directory is scanned with {@link scanTree}. Hidden names match only a
 * pattern that starts with `.`, as in the shell. A glob in an earlier component is not expanded (`unknown`).
 * @param pattern - Absolute path whose last component holds the glob.
 * @param dereference - The copy follows links (see {@link scanTree}).
 * @param how - `recursive`: matched directories are copied with their contents (a plain `cp` skips them, default true);
 *   `follow`: a matched link to a directory is entered (default: same as `dereference`).
 */
export function scanGlob(pattern: string, dereference = false, how: { recursive?: boolean; follow?: boolean } = {}): TreeContent {
  const dir = dirname(pattern);
  const pat = basename(pattern);
  if (/[*?[]/.test(dir)) return "unknown";
  const re = globRegExp(pat);
  const recursive = how.recursive ?? true;
  let out: TreeContent = "clean";
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!re.test(e.name) || (e.name.startsWith(".") && !pat.startsWith("."))) continue;
      if (CODE_NAME.test(e.name) && !e.isDirectory()) return "code";
      // a matched link to a directory is entered only when the copy follows operand links
      const entersLink = e.isSymbolicLink() && (how.follow ?? dereference) && statSync(join(dir, e.name)).isDirectory();
      if ((e.isDirectory() || entersLink) && recursive) {
        const r = scanTree(join(dir, e.name), dereference);
        if (r === "code") return "code";
        if (r === "unknown") out = "unknown";
      }
    }
    return out;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR" ? "clean" : "unknown"; // nothing there: cp just fails
  }
}

/**
 * Inspect a directory tree on disk for code files (same {@link CODE_NAME} extensions as the gate).
 * The source root is resolved with `realpath`; inside it nothing is followed: a symlink is not entered,
 * but a link whose own name is a code file counts as code. Stops at the first code file.
 * @param dir - Absolute path of the source directory.
 * @param dereference - The copy follows links (`cp -L`): a link to a directory inside the tree is entered (each directory once, so loops end); a dangling link makes the answer `unknown`.
 * @returns `code` when at least one code file exists, `clean` when the whole tree was read without one,
 *   `unknown` when it could not be read or is larger/deeper than the bound.
 */
export function scanTree(dir: string, dereference = false): TreeContent {
  const max = treeMaxEntries();
  let seen = 0;
  try {
    const root = realpathSync(dir);
    const visited = new Set<string>([root]); // directories already queued: a link loop is read once
    const stack: Array<[string, number]> = [[root, 0]];
    while (stack.length > 0) {
      const [at, depth] = stack.pop() as [string, number];
      if (depth > MAX_DEPTH) return "unknown";
      for (const e of readdirSync(at, { withFileTypes: true })) {
        if (++seen > max) return "unknown";
        if (CODE_NAME.test(e.name) && !e.isDirectory()) return "code";
        if (dereference && e.isSymbolicLink()) { // `cp -L` copies what the link points to: enter it (once)
          const target = realpathSync(join(at, e.name));
          if (statSync(target).isDirectory() && !visited.has(target)) { visited.add(target); stack.push([target, depth + 1]); }
        } else if (e.isDirectory()) {
          const next = join(at, e.name);
          if (!visited.has(next)) { visited.add(next); stack.push([next, depth + 1]); }
        }
      }
    }
    return "clean";
  } catch {
    return "unknown";
  }
}

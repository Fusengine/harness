/**
 * Filesystem helpers for the cartographer tree walk. Ports the fs parts of
 * `describe.py` (file desc) and `write_recursive.py` (children).
 */
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { descFromText, isDescribableSuffix } from "../../../policy/cartographer/describe";
import { hasUnclosedFrontmatter, parseField } from "../../../policy/cartographer/frontmatter";
import { detach, readDescription } from "./bounded-read";

/**
 * Derive a file's one-line description (frontmatter / heading / comment). The
 * extension is checked first: files that cannot have a description (pdf, png,
 * unknown extensions, ...) are never opened. Reads are bounded
 * (see {@link readDescription}); a truncated `.md` whose frontmatter is not closed
 * in the prefix gets no description. "" on any error or when nothing is found.
 * @param filePath - Absolute path to the file.
 * @returns The description, or "".
 */
export function getFileDesc(filePath: string): string {
  const suffix = extname(filePath);
  if (!isDescribableSuffix(suffix)) return "";
  const { text, truncated } = readDescription(filePath);
  if (!text) return "";
  if (truncated && suffix === ".md" && hasUnclosedFrontmatter(text)) return "";
  const mdField = suffix === ".md" ? parseField(text, "description") : "";
  return detach(descFromText(suffix, text, mdField)); // a slice would pin the whole file text in memory
}

/** Absolute children of `source`, split into dirs/files, sorted by full path. */
export function listChildren(source: string, exclude: ReadonlySet<string>): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    return { dirs, files };
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.startsWith("_") || exclude.has(e.name)) continue;
    const abs = join(source, e.name);
    if (e.isDirectory()) dirs.push(abs);
    else if (e.isFile()) files.push(abs);
  }
  return { dirs: dirs.sort(), files: files.sort() };
}

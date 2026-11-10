/**
 * Frontmatter parsing — pure text helpers (no fs). Ports `parse_frontmatter.py`.
 */

const BLOCK_SCALARS: ReadonlySet<string> = new Set(["|", ">", "|+", "|-", ">+", ">-"]);

/** Escape regex metacharacters in an arbitrary field name. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` opens a `---` frontmatter block that is not closed within it
 * (a truncated prefix cut inside the YAML): its content must never be read as
 * Markdown body.
 * @param text - The document text (possibly a prefix).
 * @returns True when a leading `---` fence has no closing `---`.
 */
export function hasUnclosedFrontmatter(text: string): boolean {
  return /^---\s*\n/.test(text) && !/^---\s*\n[\s\S]*?\n---/.test(text);
}

/**
 * Extract a single frontmatter field's value from `text`. Strips surrounding
 * quotes; skips YAML block-scalar markers. Returns "" when absent.
 * @param text - The full document text.
 * @param field - The frontmatter key to read.
 * @returns The field value, or "".
 */
export function parseField(text: string, field: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!fm || fm[1] === undefined) return "";
  const lineRe = new RegExp(`^${escapeRe(field)}\\s*:\\s*(.+)$`);
  for (const line of fm[1].split("\n")) {
    const m = lineRe.exec(line);
    if (!m || m[1] === undefined) continue;
    const val = m[1].trim().replace(/^["']|["']$/g, "");
    if (BLOCK_SCALARS.has(val)) continue;
    return val;
  }
  return "";
}

/**
 * Derive a short description from the body following the frontmatter: the first
 * non-empty trimmed line, sliced to `maxLen`. Returns "" when none.
 * @param text - The full document text.
 * @param maxLen - Maximum length of the returned description.
 * @returns The body-derived description, or "".
 */
export function parseBodyDesc(text: string, maxLen: number = 60): string {
  const m = /^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/.exec(text);
  if (!m || m[1] === undefined) return "";
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (line) return line.slice(0, maxLen);
  }
  return "";
}

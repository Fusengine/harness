import { isAbsolute, relative, sep } from "node:path";

/**
 * True when `path` equals `root` or lies below it (same path flavour: both lexical or both real).
 * A sibling named `..foo` is inside; only a real `..` segment (or a different drive) is outside.
 * @param root - Directory root.
 * @param path - Candidate path.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

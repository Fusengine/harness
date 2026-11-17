/**
 * @module project-relative
 * Path-intent helper shared by the gates that guess "is this a UI / shadcn file" from path fragments.
 * @packageDocumentation
 */
import { isAbsolute, relative } from "node:path";
import { isInsideRoot } from "../util/is-inside-root";

/**
 * The part of `filePath` a path-FRAGMENT heuristic (`ui`, `components`, `nav`, ...) may look at: the path
 * relative to the project root when the file lives inside it, else the path unchanged. Folders ABOVE the
 * project (e.g. `/Users/x/build-ui-tools/`) say nothing about whether this file is UI. The relative path is a
 * suffix of the absolute one, so a fragment gate keyed on it can only lose a match, never gain one.
 * Exemption lists (`node_modules`, `dist`, ...) must keep testing the absolute path.
 * @param filePath - The written file path.
 * @param projectRoot - Project root; absent or non-absolute returns `filePath` unchanged.
 * @returns The path the fragment heuristic should test.
 */
export function projectRelativePath(filePath: string, projectRoot: string | undefined): string {
  if (!projectRoot || !isAbsolute(projectRoot) || !isAbsolute(filePath)) return filePath;
  const rel = relative(projectRoot, filePath);
  return rel !== "" && isInsideRoot(projectRoot, filePath) ? rel : filePath;
}

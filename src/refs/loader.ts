import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { parseFrontmatter } from "./frontmatter";
import type { RefMeta } from "./types";

function pick(fm: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = fm[k];
    if (v) return v;
  }
  return "";
}

const SOLID_SLUGS = new Set(["single-responsibility", "open-closed", "liskov-substitution", "interface-segregation", "dependency-inversion", "solid-principles"]);

/** Infer a ref's level from its path when the frontmatter omits it (templates/→template, SOLID slug→principle). */
function inferLevel(filePath: string): string {
  if (filePath.includes("/templates/")) return "template";
  const stem = (filePath.split("/").pop() ?? "").replace(/\.md$/, "");
  return SOLID_SLUGS.has(stem) ? "principle" : "architecture";
}

/** Build a {@link RefMeta} from parsed frontmatter, tolerant of kebab/camel keys. */
export function toRefMeta(fm: Record<string, string>, filePath: string): RefMeta {
  return {
    name: pick(fm, "name") || filePath,
    description: pick(fm, "description"),
    keywords: pick(fm, "keywords"),
    priority: pick(fm, "priority"),
    related: pick(fm, "related"),
    appliesTo: pick(fm, "appliesTo", "applies-to", "applies_to"),
    triggerOnEdit: pick(fm, "triggerOnEdit", "trigger-on-edit", "trigger_on_edit"),
    level: pick(fm, "level") || inferLevel(filePath),
    filePath,
  };
}

/**
 * How many refs {@link loadRefs} would load from ONE dir, WITHOUT throwing: it runs
 * the same steps synchronously (recursive readdir, read every `.md` as utf8, parse
 * its frontmatter into a {@link RefMeta}) and returns 0 on ANY failure (unreadable
 * dir or file, dangling symlink, a directory named `a.md`). Used to decide whether a
 * dir is safe to prefer over another source before the gate ever loads it.
 * @param dir - One refs dir.
 */
export function loadableRefCount(dir: string): number {
  try {
    let n = 0;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".md")) continue;
      const filePath = join(dir, rel);
      toRefMeta(parseFrontmatter(readFileSync(filePath, "utf8")), filePath);
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Scan a directory recursively for `.md` reference files and parse each into a
 * {@link RefMeta}. The content is entirely the consumer's — point this at any
 * refs dir (`FUSE_HARNESS_REFS`). Returns an empty list when the dir is absent.
 */
export async function loadRefs(dirs: string): Promise<RefMeta[]> {
  const refs: RefMeta[] = [];
  for (const dir of dirs.split(delimiter).filter(Boolean)) {
    let entries: string[];
    try {
      entries = (await readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const rel of entries) {
      if (!rel.endsWith(".md")) continue;
      const filePath = join(dir, rel);
      refs.push(toRefMeta(parseFrontmatter(await readFile(filePath, "utf8")), filePath));
    }
  }
  return refs;
}

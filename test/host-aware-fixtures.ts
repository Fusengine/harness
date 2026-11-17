import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefMeta } from "../src/refs/types";

const made: string[] = [];

/** A fresh temp dir; parked in the Trash (never rm) when the test file ends. */
export function tmp(prefix = "fh-hostmsg-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

afterAll(() => {
  const trash = join(process.env.HOME ?? "/", ".Trash");
  for (const d of made) { try { renameSync(d, join(trash, `${d.split("/").pop()}-${Date.now()}`)); } catch { /* best effort */ } }
});

/** Create `<skillsDir>/<name>/{SKILL.md,references/}`; returns the references dir. */
export function mkSkill(skillsDir: string, name: string): string {
  const refs = join(skillsDir, name, "references");
  mkdirSync(refs, { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), "# skill\n");
  return refs;
}

/** A routable ref (applies to every .tsx). */
export function ref(filePath: string, name: string, level: string): RefMeta {
  return { name, description: "", keywords: "", priority: "", related: "", appliesTo: "**/*.tsx", triggerOnEdit: "", level, filePath };
}

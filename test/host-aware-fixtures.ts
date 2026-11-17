import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefMeta } from "../src/refs/types";

/** A fresh temp dir (left to the normal tmp cleanup; nothing here ever writes under the real home). */
export function tmp(prefix = "fh-hostmsg-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A fake host home under a temp dir, wired into the code under test through the
 * `FUSE_HARNESS_HOME` override (Bun caches `os.homedir()`, so `HOME` cannot be
 * changed in-process). The previous value is restored when the test file ends.
 * No test may build a layout under the real home.
 */
export function fakeHome(): string {
  const home = tmp("fh-fakehome-");
  const prev = process.env.FUSE_HARNESS_HOME;
  process.env.FUSE_HARNESS_HOME = home;
  afterAll(() => {
    if (prev === undefined) delete process.env.FUSE_HARNESS_HOME; else process.env.FUSE_HARNESS_HOME = prev;
  });
  return home;
}

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

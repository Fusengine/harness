import { describe, test, expect, afterEach } from "bun:test";
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripNativeDoc } from "../src/runtime/inject-session/native-doc";
import { cleanup, tmp } from "./inject-session-helpers";

afterEach(cleanup);
const DOC = "OWNER-DOC ".repeat(30);
const text = `APEX\n\n# CLAUDE.md\n${DOC}`;

/** Home with a regular ~/.claude/CLAUDE.md, plus a project dir wired through CLAUDE_PROJECT_DIR. */
function setup(): { home: string; proj: string } {
  const home = tmp();
  const proj = tmp();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), DOC);
  process.env.CLAUDE_PROJECT_DIR = proj;
  delete process.env.CLAUDE_CONFIG_DIR;
  return { home, proj };
}

describe("E: native CLAUDE.md strip only when it is really the native file", () => {
  test("regular file: stripped", () => {
    const { home } = setup();
    expect(stripNativeDoc(text, home)).toBe("APEX");
  });
  test("symlink: kept", () => {
    const { home } = setup();
    const real = join(home, "real.md");
    writeFileSync(real, DOC);
    rmSync(join(home, ".claude", "CLAUDE.md"));
    symlinkSync(real, join(home, ".claude", "CLAUDE.md"));
    expect(stripNativeDoc(text, home)).toBe(text);
  });
  test("hardlink (nlink > 1): kept", () => {
    const { home } = setup();
    linkSync(join(home, ".claude", "CLAUDE.md"), join(home, "other.md"));
    expect(stripNativeDoc(text, home)).toBe(text);
  });
  test("claudeMdExcludes in the user, project or local layer matching it: kept", () => {
    for (const layer of ["user", "project", "local"]) {
      const { home, proj } = setup();
      const where = layer === "user" ? join(home, ".claude", "settings.json") : join(proj, ".claude", layer === "project" ? "settings.json" : "settings.local.json");
      mkdirSync(join(where, ".."), { recursive: true });
      writeFileSync(where, JSON.stringify({ claudeMdExcludes: ["**/.claude/CLAUDE.md"] }));
      expect(stripNativeDoc(text, home)).toBe(text);
    }
  });
  test("non-matching excludes still strip; unparsable settings: kept", () => {
    const { home } = setup();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ claudeMdExcludes: ["**/monorepo/CLAUDE.md"] }));
    expect(stripNativeDoc(text, home)).toBe("APEX");
    writeFileSync(join(home, ".claude", "settings.json"), "{broken");
    expect(stripNativeDoc(text, home)).toBe(text);
  });
  test("CLAUDE_CONFIG_DIR: kept unless it resolves (realpath) to the same dir", () => {
    const { home } = setup();
    process.env.CLAUDE_CONFIG_DIR = tmp();
    expect(stripNativeDoc(text, home)).toBe(text);
    const alias = join(tmp(), "alias");
    symlinkSync(join(home, ".claude"), alias);
    process.env.CLAUDE_CONFIG_DIR = alias;
    expect(stripNativeDoc(text, home)).toBe("APEX");
  });
});

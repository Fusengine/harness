import { test, expect } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { discoverRefs } from "../src/refs/discover";
import { refsDirFor } from "../src/refs/refs-override";
import { loadRefs } from "../src/refs/loader";
import { solidReadGate } from "../src/policy/apex";
import { mkSkill, tmp } from "./host-aware-fixtures";

const MD = "---\nname: x\napplies-to: \"**/*.ts\"\nlevel: principle\n---\n# x\n";
const MKTS = ["fusengine-plugins", "fusengine-codex"];
const SKILLS_ROOT: Record<string, string[]> = {
  codex: [".codex", "plugins", "cache", "fusengine-codex", "x", "1.0.0", "skills"],
  kimi: [".kimi-code", "skills"],
  cursor: [".cursor", "plugins", "local", "x", "skills"],
};

/** `<home>/.claude/.../<skill>/references` populated with `files` .md files; returns the references dir. */
function claudeRefs(home: string, skill: string, files = 3): string {
  const refs = mkSkill(join(home, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins", "solid", "skills"), skill);
  for (let i = 0; i < files; i++) writeFileSync(join(refs, `r${i}.md`), MD);
  return refs;
}

/** A host skill; `files = 0` leaves its references dir EMPTY. */
function hostSkill(home: string, id: string, skill: string, files: number): string {
  const refs = mkSkill(join(home, ...SKILLS_ROOT[id]!), skill);
  for (let i = 0; i < files; i++) writeFileSync(join(refs, `h${i}.md`), MD);
  return refs;
}

const gate = async (id: string, dirs: string) =>
  solidReadGate({ hostId: id, sessionId: "s", framework: "generic", filePath: "/p/src/util.ts", content: "export const a = 1;", refs: await loadRefs(dirs) });

test("an EMPTY host references dir never switches the gate off: the override (17 refs on base) is used and the deny is unchanged", async () => {
  for (const id of ["codex", "kimi", "cursor"]) {
    const home = tmp();
    const override = [claudeRefs(home, "solid-generic", 17)].join(delimiter);
    hostSkill(home, id, "solid-generic", 0); // empty/non-.md: loadRefs would return 0 refs
    const dir = refsDirFor(home, "/tmp/nowhere", MKTS, id, { FUSE_HARNESS_REFS: override });
    expect(dir).toBe(override);
    const base = await gate("claude-code", override);
    const live = await gate(id, dir as string);
    expect(live?.kind).toBe("block");
    expect(live?.actions).toEqual(base?.actions as string[]);
  }
});

test("host covers only SOME of the override's skill keys → per key: host dir where it loads, the override's dir for the rest (no key dropped)", () => {
  for (const id of ["codex", "kimi", "cursor"]) {
    const home = tmp();
    // Override dirs live under <home>/.claude but outside the discoverable marketplace layout, so no shared fallback can supply solid-react.
    const custom = (skill: string): string => {
      const refs = mkSkill(join(home, ".claude", "custom"), skill);
      writeFileSync(join(refs, "r0.md"), MD);
      return refs;
    };
    const override = [custom("solid-generic"), custom("solid-react")].join(delimiter);
    const hostGeneric = hostSkill(home, id, "solid-generic", 3); // no solid-react in the host
    const customReact = override.split(delimiter)[1]!;
    expect(refsDirFor(home, "/tmp/nowhere", MKTS, id, { FUSE_HARNESS_REFS: override })).toBe([hostGeneric, customReact].join(delimiter));
  }
});

test("an override that loads 0 refs behaves exactly as base", () => {
  const home = tmp();
  const override = claudeRefs(home, "solid-generic", 0);
  hostSkill(home, "codex", "solid-generic", 3);
  expect(refsDirFor(home, "/tmp/nowhere", MKTS, "codex", { FUSE_HARNESS_REFS: override })).toBe(override);
});

test("live F1: the host covers every override key → host paths win, printed, and reading them clears the deny", async () => {
  for (const id of ["codex", "kimi", "cursor"]) {
    const home = tmp();
    const override = [claudeRefs(home, "solid-generic"), claudeRefs(home, "solid-react")].join(delimiter);
    const own = [hostSkill(home, id, "solid-generic", 3), hostSkill(home, id, "solid-react", 2)];
    const dir = refsDirFor(home, "/tmp/nowhere", MKTS, id, { FUSE_HARNESS_REFS: override }) as string;
    expect(dir.split(delimiter).sort()).toEqual(own.sort());
    const deny = await gate(id, dir);
    expect(deny?.kind).toBe("block");
    expect(JSON.stringify(deny)).not.toContain(".claude");
    expect(await gate(id, dir).then((d) => d?.actions)).toBeDefined();
    const ctx = { hostId: id, sessionId: "s", framework: "generic", filePath: "/p/src/util.ts", content: "export const a = 1;", refs: await loadRefs(dir) };
    expect(solidReadGate({ ...ctx, refsRead: deny?.actions })).toBeNull();
  }
});

test("discovery never descends into dot-directories: a newer .cartographer copy cannot shadow the real skill", () => {
  const home = tmp();
  const plugin = join(home, ".cursor", "plugins", "local", "fuse-react");
  const real = mkSkill(join(plugin, "skills"), "solid-react");
  writeFileSync(join(real, "a.md"), MD);
  const carto = mkSkill(join(plugin, ".cartographer", "skills"), "solid-react");
  writeFileSync(join(carto, "index.md"), MD);
  utimesSync(join(plugin, "skills"), new Date(2020, 1, 1), new Date(2020, 1, 1));
  utimesSync(join(plugin, ".cartographer"), new Date(), new Date());
  mkdirSync(join(plugin, ".git"), { recursive: true });
  expect(discoverRefs(home, "/tmp/nowhere", MKTS, "cursor", {}).split(delimiter).filter((p) => p.includes("solid-react"))).toEqual([real]);
});

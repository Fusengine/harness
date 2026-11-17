import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { discoverRefs } from "../src/refs/discover";
import { refsDirFor } from "../src/refs/refs-override";
import { loadRefs } from "../src/refs/loader";
import { solidReadGate } from "../src/policy/apex";
import { messageHost } from "../src/policy/host-skill-paths";
import type { RefMeta } from "../src/refs/types";
import { mkSkill, tmp } from "./host-aware-fixtures";

const MD = "---\nname: x\napplies-to: \"**/*\"\nlevel: principle\n---\n# x\n";
const MKTS = ["fusengine-plugins", "fusengine-codex"];
const HOST_SKILLS: Record<string, string[]> = {
  codex: [".codex", "plugins", "cache", "fusengine-codex", "x", "1.0.0", "skills"],
  kimi: [".kimi-code", "skills"],
  cursor: [".cursor", "plugins", "local", "x", "skills"],
};
const KEYS = ["solid-generic", "solid-react"];

/** Ways a host `references` dir can be unusable for loadRefs (the challenger matrix). */
const BREAKERS: Record<string, (refs: string) => void> = {
  empty: () => {},
  nonmd: (r) => writeFileSync(join(r, "a.txt"), "x"),
  upperMD: (r) => writeFileSync(join(r, "A.MD"), MD),
  partial: (r) => { writeFileSync(join(r, "good.md"), MD); symlinkSync(join(r, "missing-target"), join(r, "bad.md")); },
  dangling: (r) => symlinkSync(join(r, "missing-target"), join(r, "a.md")),
  unreadable: (r) => { writeFileSync(join(r, "a.md"), MD); chmodSync(join(r, "a.md"), 0o000); },
  dirmd: (r) => mkdirSync(join(r, "a.md")),
};

const keyOf = (p: string): string => /\/([^/]+)\/references\//.exec(p)?.[1] ?? "?";
const keys = (refs: RefMeta[]): string[] => [...new Set(refs.map((r) => keyOf(r.filePath)))].sort();

/** Base source exactly as 1331bcd computed it: the override, else shared discovery with NO host id. */
function setup(host: string, breaker: string, withOverride: boolean): { home: string; id: string; env: Record<string, string | undefined>; base: string } {
  const home = tmp();
  const claude = join(home, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins", "solid", "skills");
  for (const k of KEYS) { const r = mkSkill(claude, k); for (let i = 0; i < 3; i++) writeFileSync(join(r, `c${i}.md`), MD); }
  const hostSkills = join(home, ...HOST_SKILLS[host]!);
  const good = mkSkill(hostSkills, "solid-generic");
  writeFileSync(join(good, "h0.md"), MD);
  BREAKERS[breaker]!(mkSkill(hostSkills, "solid-react"));
  const baseDirs = discoverRefs(home, "/tmp/nowhere", MKTS);
  const env = withOverride ? { FUSE_HARNESS_REFS: baseDirs } : {};
  return { home, id: host, env, base: baseDirs };
}

const verdict = async (dirs: string, file: string, framework: string, hostId: string) => {
  const d = solidReadGate({ hostId, sessionId: "s", framework, filePath: file, content: "x", refs: await loadRefs(dirs) });
  return { kind: d?.kind ?? null, keys: (d?.actions ?? []).map(keyOf).sort() };
};

for (const withOverride of [false, true]) {
  for (const breaker of Object.keys(BREAKERS)) {
    for (const host of ["codex", "kimi", "cursor"]) {
      test(`${breaker} host refs, ${withOverride ? "home .claude override" : "no override"}, ${host}: loads, keeps every base key, same verdict as base`, async () => {
        const { home, id, env, base } = setup(host, breaker, withOverride);
        const dirs = refsDirFor(home, "/tmp/nowhere", MKTS, id, env) as string;
        const refs = await loadRefs(dirs); // must not throw
        expect(keys(refs)).toEqual(keys(await loadRefs(base)));
        for (const [file, fw] of [["/p/a.ts", "generic"], ["/p/a.tsx", "react"]] as const) {
          const want = await verdict(base, file, fw, "claude-code");
          const got = await verdict(dirs, file, fw, id);
          expect(got.kind).toBe(want.kind);
          expect(got.keys).toEqual(want.keys);
        }
      });
    }
  }
}

test("claude-code invocation with CURSOR_VERSION (messageHost = cursor) takes the same guarded path", async () => {
  const { home, env, base } = setup("cursor", "dangling", true);
  const id = messageHost("claude-code", { CURSOR_VERSION: "3" });
  expect(id).toBe("cursor");
  const dirs = refsDirFor(home, "/tmp/nowhere", MKTS, id, env) as string;
  expect(keys(await loadRefs(dirs))).toEqual(keys(await loadRefs(base)));
});

test("live F1: the host covers every key with loadable refs → host paths printed, deny clears after reading them", async () => {
  for (const host of ["codex", "kimi", "cursor"]) {
    const { home, env } = setup(host, "empty", true);
    writeFileSync(join(join(home, ...HOST_SKILLS[host]!, "solid-react", "references"), "h0.md"), MD); // host solid-react now loadable too
    const dirs = refsDirFor(home, "/tmp/nowhere", MKTS, host, env) as string;
    expect(dirs.split(delimiter).every((d) => d.startsWith(join(home, HOST_SKILLS[host]![0]!)))).toBe(true);
    const refs = await loadRefs(dirs);
    const deny = solidReadGate({ hostId: host, sessionId: "s", framework: "generic", filePath: "/p/a.ts", content: "x", refs });
    expect(deny?.kind).toBe("block");
    expect(JSON.stringify(deny)).not.toContain(".claude");
    expect(solidReadGate({ hostId: host, sessionId: "s", framework: "generic", filePath: "/p/a.ts", content: "x", refs, refsRead: deny?.actions })).toBeNull();
  }
});

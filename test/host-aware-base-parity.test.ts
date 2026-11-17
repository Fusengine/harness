import { test, expect } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { discoverRefs } from "../src/refs/discover";
import { refsDirFor } from "../src/refs/refs-override";
import { loadRefs } from "../src/refs/loader";
import { solidReadGate } from "../src/policy/apex";
import { hostHome } from "../src/policy/host-skill-paths";
import { mkSkill, tmp } from "./host-aware-fixtures";

const MD = "---\nname: x\napplies-to: \"**/*\"\nlevel: principle\n---\n# x\n";
const MKTS = ["fusengine-plugins", "fusengine-codex"];

const verdict = async (dirs: string | undefined) =>
  solidReadGate({ hostId: "claude-code", sessionId: "s", framework: "generic", filePath: "/p/a.ts", content: "x", refs: dirs ? await loadRefs(dirs) : undefined })?.kind ?? null;

/** Version cache with two versions: 2.0.0 created FIRST with an empty references dir, 1.9.0 second with a real ref. */
function reverseVersionCache(home: string, seg: string, mkt: string): string {
  const plugin = join(home, seg, "plugins", "cache", mkt, "fuse-solid");
  mkSkill(join(plugin, "2.0.0", "skills"), "solid-generic"); // empty references
  writeFileSync(join(mkSkill(join(plugin, "1.9.0", "skills"), "solid-generic"), "b.md"), MD);
  return plugin;
}

test("base discovery keeps the 1331bcd raw readdir order in version caches (no version re-ordering): Claude Code and Codex verdict = base", async () => {
  for (const [seg, mkt, id] of [[".claude", "fusengine-plugins", "claude-code"], [".codex", "fusengine-codex", "codex"]] as const) {
    const home = tmp();
    const plugin = reverseVersionCache(home, seg, mkt);
    // What the 1331bcd loop picks: the FIRST version dir in raw readdir order that has a references dir.
    const first = readdirSync(plugin)[0]!;
    const expected = join(plugin, first, "skills", "solid-generic", "references");
    expect(discoverRefs(home, "/tmp/nowhere", MKTS)).toBe(expected);
    // The invocation (host or not) computes the same base, hence the same verdict.
    expect(await verdict(refsDirFor(home, "/tmp/nowhere", MKTS, id, {}))).toBe(await verdict(expected));
  }
});

test("FUSE_HARNESS_HOME (host-owned lookup only) pointing at an empty dir never changes the base verdict", async () => {
  const home = tmp();
  mkSkill(join(home, ".claude", "plugins", "marketplaces", "fusengine-plugins", "plugins", "solid", "skills"), "solid-generic");
  const base = discoverRefs(home, "/tmp/nowhere", MKTS);
  writeFileSync(join(base.split(delimiter)[0]!, "c0.md"), MD);
  const empty = tmp();
  const env = { FUSE_HARNESS_HOME: empty };
  for (const id of ["codex", "kimi", "cursor", "claude-code"]) {
    const dirs = refsDirFor(home, "/tmp/nowhere", MKTS, id, env, hostHome(env));
    expect(dirs).toBe(base);
    expect(await verdict(dirs)).toBe(await verdict(base));
  }
});

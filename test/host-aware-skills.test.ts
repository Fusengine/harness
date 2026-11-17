import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { skillTriggerGate, detectRequiredSkills } from "../src/policy/skill-triggers";
import { tailwindSkillGate } from "../src/policy/tailwind-skill-gate";
import { resolveSkillPath } from "../src/policy/skill-path";
import { browserNavigateGate } from "../src/policy/design/gates-pipeline";
import { solidReadGate } from "../src/policy/apex";
import { initDesignState } from "../src/policy/design/state";
import { mkSkill } from "./host-aware-fixtures";

// Run with an isolated HOME on the command line: every fake host install is built under it.
const HOME = homedir();
const SKILLS: Record<string, string> = {
  codex: join(HOME, ".codex", "plugins", "cache", "fusengine-codex", "react-expert", "1.0.39", "skills"),
  kimi: join(HOME, ".kimi-code", "plugins", "managed", "fusengine", "plugins", "react-expert", "skills"),
  cursor: join(HOME, ".cursor", "plugins", "cache", "fusengine-cursor-plugins", "fuse-react", "abc123", "skills"),
};
const react19 = ["useActionState(a)", "useOptimistic(a)", "use(promise)", "useFormStatus()", "<form action={fn}>"].find((c) => detectRequiredSkills("react", c).includes("react-19")) ?? "useActionState(a)";

test("react sub-skill deny: each host is shown ITS OWN skill path, and reading it clears the deny; Claude byte-identical", () => {
  const base = skillTriggerGate("react", react19, [], null, undefined, "/p/a.tsx");
  expect(base?.actions?.[0]).toBe(`Read ${resolveSkillPath("react-19")}`);
  expect(skillTriggerGate("react", react19, [], null, undefined, "/p/a.tsx", "claude-code")).toEqual(base);
  for (const [id, dir] of Object.entries(SKILLS)) {
    mkSkill(dir, "react-19");
    const own = join(dir, "react-19", "SKILL.md");
    const deny = skillTriggerGate("react", react19, [], null, undefined, "/p/a.tsx", id);
    expect(deny?.actions).toEqual([`Read ${own}`]);
    // The gate credits a read by its `skills/<name>/` segment: the host-owned copy clears it exactly like the ~/.claude one did.
    expect(skillTriggerGate("react", react19, [own], null, undefined, "/p/a.tsx", id)).toBeNull();
  }
});

test("tailwind base-skill deny: host-owned paths, cleared by reading either", () => {
  const content = '<div className="flex p-4">x</div>';
  const base = tailwindSkillGate("Write", "/p/a.tsx", content, []);
  expect(tailwindSkillGate("Write", "/p/a.tsx", content, [], "claude-code")).toEqual(base);
  const dir = join(HOME, ".codex", "plugins", "cache", "fusengine-codex", "tailwindcss-expert", "1.0.0", "skills");
  mkSkill(dir, "tailwindcss-v4");
  mkSkill(dir, "tailwindcss-utilities");
  const deny = tailwindSkillGate("Write", "/p/a.tsx", content, [], "codex");
  expect(deny?.actions?.[0]).toBe(`Read ${join(dir, "tailwindcss-v4", "SKILL.md")} or ${join(dir, "tailwindcss-utilities", "SKILL.md")}`);
  expect(tailwindSkillGate("Write", "/p/a.tsx", content, [join(dir, "tailwindcss-v4", "SKILL.md")], "codex")).toBeNull();
});

test("generic framework: a non-Claude host resolves solid-generic (never the phantom generic/ path)", () => {
  const dir = join(HOME, ".kimi-code", "plugins", "managed", "fusengine", "plugins", "solid", "skills");
  mkSkill(dir, "solid-generic");
  const refs = [{ name: "a", description: "", keywords: "", priority: "", related: "", appliesTo: "**/*.py", triggerOnEdit: "", level: "principle", filePath: "/x/y.md" }];
  const gate = solidReadGate({ hostId: "kimi", sessionId: "s", framework: "generic", filePath: "/p/a.ts", content: "", refs });
  expect(gate?.actions?.[0]).toBe(`Read ${join(dir, "solid-generic")}/SKILL.md`);
});

test("Cursor cache: with several hash dirs the most recently modified wins (not readdir order)", () => {
  const root = join(HOME, ".cursor", "plugins", "cache", "fusengine-cursor-plugins", "fuse-vue");
  const old = join(root, "aaa-old", "skills");
  const fresh = join(root, "zzz-new", "skills");
  mkSkill(fresh, "vue-x");
  mkSkill(old, "vue-x");
  utimesSync(join(root, "aaa-old"), new Date(2020, 1, 1), new Date(2020, 1, 1));
  utimesSync(join(root, "zzz-new"), new Date(), new Date());
  const deny = skillTriggerGate("react", "x", [], "vue-x", undefined, "/p/a.tsx", "cursor");
  expect(deny?.actions?.[0]).toBe(`Read ${join(fresh, "vue-x", "SKILL.md")}`);
});

test("design navigate gate: Claude unchanged; a host points at its own design-system skill when installed", () => {
  const state = initDesignState("a", "page", false);
  const base = browserNavigateGate(state, "");
  expect(browserNavigateGate(state, "", "claude-code")).toEqual(base);
  const dir = join(HOME, ".codex", "plugins", "cache", "fusengine-codex", "design-expert", "1.0.0", "skills");
  mkSkill(dir, "design-system");
  const deny = browserNavigateGate(state, "", "codex");
  expect(deny?.reason).toContain(`READ: ${join(dir, "design-system")}/SKILL.md`);
  expect(deny?.reason).not.toContain("~/.claude");
});

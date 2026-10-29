import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionHook } from "../src/runtime/motion";
import { normalizeEvent } from "../src/runtime/normalize";
import { motionHome, motionKeyDirectory } from "../src/policy/motion/store";

/** Motion data lives in ~/.fuse-harness/video-motion (store) and video-motion/keys (signing keys). */
const made: string[] = [];
const fresh = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "motion-vm-"))); made.push(dir); return dir; };
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const home = fresh();
const project = join(home, "video");
const plain = join(home, "plain");
mkdirSync(join(home, ".fuse-harness/cache/sessions"), { recursive: true });
mkdirSync(join(home, ".fuse-harness/video-motion/keys"), { recursive: true });
mkdirSync(join(project, ".motion"), { recursive: true });
mkdirSync(plain, { recursive: true });
writeFileSync(join(project, ".motion/project.json"), JSON.stringify({ render: "render.sh", masters: ["out/master.mp4"] }));
writeFileSync(join(home, ".fuse-harness/video-motion/keys/a.key"), "secret");
symlinkSync(join(home, ".fuse-harness"), join(project, "hl"));
symlinkSync(join(home, ".fuse-harness/video-motion/keys"), join(home, "alias-keys"));
symlinkSync("../video-motion/keys", join(home, ".fuse-harness/cache/lnk"));

async function hook(tool: string, input: Record<string, unknown>, cwd: string): Promise<string> {
  const payload = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input };
  return (await motionHook("claude-code", payload, normalizeEvent("claude-code", payload), { cwd, home, now: 1 })).stdout;
}
const bash = (command: string, cwd: string) => hook("Bash", { command }, cwd);

const OWNER = [
  "f=~/.fuse-harness/cache/sessions/x.json; ls -la $f; jq '.pending[]' $f",
  "for f in ~/.fuse-harness/cache/sessions/*.json; do jq . $f; done",
  "ls ~/.fuse-harness/",
  "cat ~/.fuse-harness/cache/*/x.json",
];

test("owner harness commands no longer touch Motion data: allowed outside and inside a Motion project", async () => {
  for (const cwd of [plain, project, home]) for (const command of OWNER) expect([command, await bash(command, cwd)]).toEqual([command, ""]);
});

test("paths resolve to video-motion and video-motion/keys", () => {
  expect(motionHome(home)).toBe(join(home, ".fuse-harness/video-motion"));
  expect(motionKeyDirectory(home)).toBe(join(home, ".fuse-harness/video-motion/keys"));
});

test("key and store access naming video-motion is blocked (literal, glob, variable, native tools), inside and outside a project", async () => {
  const keyed = [
    "cat ~/.fuse-harness/video-motion/keys/a.key", "cat $HOME/.fuse-harness/video-motion/keys/a.key", "cat ~/.fuse-harness/video-motion/keys/*", "cat ~/.fuse-harness/video-motion/k*/*",
    "cat ~/.fuse-harness/video-motion/*/*", "cat ~/.fuse-harness/video-motion*/keys/*", "cat ~/.fuse-harness/v*/k*/*", "cat ~/.fuse-harness/*/keys/*", "cat ~/.fuse-har*/video-motion/keys/*",
    "D=$HOME/.fuse-harness/video-motion; cat $D/k*/*", "D=~/.fuse-harness/video-motion; cat \"$D\"/keys/a.key", "a=video-mo; b=tion; cat ~/.fuse-harness/$a$b/keys/*",
    "ls ~/.fuse-harness/video-motion/", "rg -L x ~/.fuse-harness/video-motion", "grep -r x ~/.fuse-harness", "find -L ~/.fuse-harness -name '*.key'", "cp -R ~/.fuse-harness /tmp/c",
    "tar -C ~/.fuse-harness/video-motion -xf a.tar", "cat ~/alias-keys/a.key", "cat hl/video-motion/keys/a.key", "cat ~/.fuse-harness/cache/lnk/a.key", "cat ~/.fuse-harness/cache/lnk/*",
    "cd ~/.fuse-harness/video-motion && cat keys/a.key", "cd ~/.fuse-harness/video-motion; cat k*/*", "cd ~/.fuse-harness/cache && cat ../video-motion/keys/a.key",
    "cd ~/.fuse-harness/cache; cat ../v*/k*/a.key", "cd ~/.fuse-harness/c*; cat ../v*/k*/a.key", "X=~/.fuse-harness; cat $X/v*/k*/*", "set -- ~/.fuse-harness; cat $1/v*/k*/*",
    "for d in ~/.fuse-harness; do cat $d/*/*/a.key; done", "cat ~/.fuse-harness/cache/../video-motion/keys/a.key", "cat ~/.fuse-harness/cache/$'..'/video-motion/keys/a.key",
    "cat ~/.fuse-harness/cache/.[.]/v*/k*/a.key", "cat ~/.fuse-harness/cache/${X:-..}/video-motion/keys/a.key", "cat ~/.fuse-harness/{cache,video-motion}/keys/a.key",
    "cat ~/.fuse-harness/Video-Motion/keys/a.key", "cat ~/.fuse-harness/video-motion/keys/a.key | sh",
  ];
  for (const cwd of [plain, project]) for (const command of keyed) expect([cwd === plain ? "out" : "in", command, await bash(command, cwd)].join("|")).toContain("signing key guard");
});

test("native tools on video-motion are blocked, including Read, Grep, Glob, Write and Edit", async () => {
  const key = join(home, ".fuse-harness/video-motion/keys/a.key");
  const calls: [string, Record<string, unknown>][] = [["Read", { file_path: key }], ["Grep", { path: join(home, ".fuse-harness/video-motion/keys"), pattern: "." }], ["Grep", { path: join(home, ".fuse-harness"), pattern: "." }], ["Glob", { pattern: `${home}/.fuse-harness/video-motion/*` }], ["Glob", { pattern: `${home}/.fuse-harness/*` }], ["Write", { file_path: key, content: "x" }], ["Edit", { file_path: key, old_string: "a", new_string: "b" }], ["Read", { file_path: join(home, "alias-keys/a.key") }]];
  for (const cwd of [plain, project]) for (const [tool, input] of calls) expect([tool, await hook(tool, input, cwd)].join("|")).toMatch(/signing key guard|self-approval/);
});

test("store writes into video-motion are denied; the legacy layout stays protected for literal paths", async () => {
  for (const command of ["echo x > ~/.fuse-harness/video-motion/k/approvals.json", "rm -rf ~/.fuse-harness/video-motion", "echo x > ~/.fuse-harness/motion/k/approvals.json", "cat ~/.fuse-harness/motion-keys/a.key"]) {
    expect([command, await bash(command, plain)].join("|")).toMatch(/self-approval|signing key guard/);
  }
});

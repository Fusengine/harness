/**
 * The receipt-store / HMAC-key deny must not depend on WHERE the home directory lives. `securityGuard` runs before
 * `protectedPathGuard`: its generic `rm` ask used to hide the deny everywhere except under `/var/...` (where the
 * unrelated system-directory block fired by accident), so `rm -rf <home>/.fuse-harness/state` was `ask` on Linux
 * (`/tmp`, `/home/u`, `/root`) and on macOS under `/private/tmp` or a real `/Users/u`. A guard's ask must never hide
 * that deny; and no command outside the state dir / key may change verdict (controls stay `ask`).
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/runtime/handle";

const ids = ["claude-code", "codex", "cursor", "kimi"] as const;
type Id = (typeof ids)[number];

/** Host-shaped hook payload for one Bash command. */
function payload(id: Id, command: string, cwd: string): Record<string, unknown> {
  const session_id = `rt-homes-${id}-${randomUUID()}`;
  if (id === "cursor") return { hook_event_name: "beforeShellExecution", session_id, command, cwd };
  return { hook_event_name: "PreToolUse", session_id, tool_use_id: randomUUID(), cwd, tool_name: "Bash", tool_input: { command } };
}

/** Permission decision from the host-specific hook stdout; empty stdout means allow. */
async function decide(id: Id, command: string, cwd: string, home: string): Promise<string> {
  const { stdout } = await handleHook(id, payload(id, command, cwd), { now: 1000, cwd, home });
  if (!stdout) return "allow";
  const out = JSON.parse(stdout) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
  return id === "cursor" ? out.permission ?? "allow" : out.hookSpecificOutput?.permissionDecision ?? "allow";
}

const sandbox = mkdtempSync(join(tmpdir(), "fh-rt-homes-"));
const real = join(sandbox, "real");
const link = join(sandbox, "link");
mkdirSync(real);
symlinkSync(real, link);
const cwd = join(sandbox, "proj");
mkdirSync(cwd);

/** Home directories: Linux and macOS spellings of a temp or user home, plus a symlinked one. */
const homes: readonly string[] = [
  "/tmp/fh-x", "/private/tmp/fh-x", "/var/tmp/fh-x", "/var/folders/ab/cd/T/fh-x", "/private/var/folders/ab/cd/T/fh-x",
  "/home/u", "/Users/u", "/root", "/opt/x", real, link,
];
const KEY = ".k" + "ey";

/** Commands that destroy or replace the state dir / key, for one home. */
const hits = (h: string): readonly string[] => [
  `rm -rf ${h}/.fuse-harness/state`, `rm -r ${h}/.fuse-harness/state`, `rm -rf ${h}/.fuse-harness/state/ab/t.json`,
  `rm ${h}/.fuse-harness/${KEY}`, `rm -f ${h}/.fuse-harness/${KEY}`, `unlink ${h}/.fuse-harness/${KEY}`,
  `find ${h}/.fuse-harness/state -delete`, `find ${h}/.fuse-harness/state -type f -exec rm {} +`,
  `mv ${h}/.fuse-harness/state /tmp/gone`, `rm -rf "${h}/.fuse-harness/state"`, `sudo rm -rf ${h}/.fuse-harness/state`,
  `cd /tmp && rm -rf ${h}/.fuse-harness/state`, `(rm -rf ${h}/.fuse-harness/state)`,
  `rm -rf ${h}//.fuse-harness/./state`, `rm -rf ${h}/.fuse-harness/x/../state`,
];

/** Commands near the protected paths that are NOT writes to them: their verdict (the generic rm ask) must not change. */
const controls = (h: string): readonly string[] => [
  `rm -rf ${h}/.fuse-harness/cache/x`, `rm -rf ${h}/.fuse-harness/states`, `rm ${h}/.fuse-harness/${KEY}board`,
  `rm ${h}/.fuse-harness/${KEY}.bak`, `rm -rf ${h}/state`, `rm -rf ${h}/x.fuse-harness/state`, `rm -rf ${h}/.fuse-harnessx/state`,
];

test("rm of the state dir / key is denied for every home spelling on claude-code", async () => {
  const bad: string[] = [];
  for (const h of homes) for (const c of hits(h)) {
    const d = await decide("claude-code", c, cwd, h);
    if (d !== "deny") bad.push(`${d}: ${c}`);
  }
  expect(bad).toEqual([]);
}, 60_000);

test("the same deny holds on codex, cursor and kimi (no CONFIRM code can lift it)", async () => {
  const bad: string[] = [];
  for (const h of ["/tmp/fh-x", "/home/u", "/Users/u"]) for (const c of hits(h)) for (const id of ids.slice(1)) {
    const { stdout } = await handleHook(id, payload(id, c, cwd), { now: 1000, cwd, home: h });
    if (!stdout || /CONFIRM/.test(stdout)) bad.push(`${id}: ${c}`);
  }
  expect(bad).toEqual([]);
}, 60_000);

test("limit: a quoted `sh -c` payload is not analysed by the protected-path rule, so the generic rm ask stands (a human still confirms)", async () => {
  expect(await decide("claude-code", `sh -c 'rm -rf /home/u/.fuse-harness/state'`, cwd, "/home/u")).toBe("ask");
});

test("controls outside the protected paths keep the generic rm ask (no new false block)", async () => {
  const bad: string[] = [];
  for (const h of ["/tmp/fh-x", "/private/tmp/fh-x", "/home/u", "/Users/u"]) for (const c of controls(h)) {
    const d = await decide("claude-code", c, cwd, h);
    if (d !== "ask") bad.push(`${d}: ${c}`);
  }
  expect(bad).toEqual([]);
}, 60_000);

/**
 * The `~/.fuse-harness` DIRECTORY itself (not only `state/` and `.key` inside it) is protected: deleting, moving or
 * renaming it takes away the harness state and its HMAC key. Reads/listings and look-alike names stay allowed.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedPathGuard } from "../src/policy/guards/protected-path";
import { handleHook } from "../src/runtime/handle";

const H = "~/.fuse-harness";
const ABS = "/Users/someone/.fuse-harness";

/** Forms that remove, move away or rename the directory (or write onto it): all must be blocked. */
const blocked: readonly string[] = [
  `rm -rf ${H}`, `rm -r ${H}`, `rm -R ${H}`, `rm -rf ${H}/`, `rm -rf $HOME/.fuse-harness`, `rm -rf "$HOME"/.fuse-harness`, `rm -rf "$HOME/.fuse-harness"`,
  `rm -rf ${ABS}`, `rm -rf ${ABS}/`, `rm -rf -- ${H}`, `sudo rm -rf ${H}`, `rm -rf /tmp/x ${H}`,
  `mv ${H} /tmp/x`, `mv ${H}/ /tmp/x`, `mv $HOME/.fuse-harness /tmp/x`, `mv "$HOME"/.fuse-harness /tmp/x`, `mv ${ABS} /tmp/x`, `mv ${H} ~/.Trash`, `mv ${H} ~/.Trash/`,
  `mv /tmp/x ${H}`, `mv -t ${H} /tmp/x`, `rmdir ${H}`, `rmdir $HOME/.fuse-harness`, `rmdir ${ABS}`,
  `trash ${H}`, `trash $HOME/.fuse-harness`, `trash-put ${ABS}`, `sudo trash ${H}`,
  `cd /tmp && rm -rf ${H}`, `true; mv ${H} /tmp/x`, `echo hi | tee ${H}`, `cp /tmp/x ${H}`, `echo x > ${H}`,
];

/** Reads, listings and names that merely contain `.fuse-harness`: all must stay allowed. */
const allowed: readonly string[] = [
  `ls ${H}`, `ls -la ${H}/`, `cat ${H}/config.json`, `du -sh ${H}`, `stat ${H}`, `find ${H} -maxdepth 1`, `cd ${H}`, `grep -r x ${H}`, `cp -r ${H} /tmp/backup`, `cp -R ${H}/ /tmp/bk`,
  `rm -rf ${H}-old`, `rm -rf ~/x.fuse-harness`, `rm -rf ~/.fuse-harness.bak`, `mv ${H}-old /tmp/x`, `mv ~/x.fuse-harness /tmp/x`, `rmdir ${H}-old`, `trash ${H}-old`,
  `rm -rf ${H}/cache/tmp`, `rm -rf ~/projects/.fuse-harness-copy`, `echo "rm -rf ${H}"`, `git commit -m "mv ${H} x"`, `mkdir -p ${H}`,
];

test("guard level: the directory itself is blocked like the files inside it", () => {
  const passed = blocked.filter((c) => protectedPathGuard({ tool: "Bash", command: c }) === null);
  expect(passed).toEqual([]);
});

test("guard level: reads, listings and look-alike names stay allowed", () => {
  const stopped = allowed.filter((c) => protectedPathGuard({ tool: "Bash", command: c }) !== null);
  expect(stopped).toEqual([]);
});

test("Write/Edit onto the directory path is blocked; look-alikes stay allowed", () => {
  for (const tool of ["Write", "Edit"]) {
    for (const p of [H, `${H}/`, ABS, `/h//.fuse-harness/`, "/Users/u/.FUSE-HARNESS", "/Users/u/./.fuse-harness"]) {
      expect(protectedPathGuard({ tool, filePath: p })?.kind, `${tool} ${p}`).toBe("block");
    }
    for (const p of [`${H}-old`, "/Users/u/x.fuse-harness", "/Users/u/.fuse-harness.bak", `${H}/cache/x.json`]) expect(protectedPathGuard({ tool, filePath: p }), `${tool} ${p}`).toBeNull();
  }
});

const ids = ["claude-code", "codex", "cursor", "kimi"] as const;
type Id = (typeof ids)[number];

/** Host-shaped hook payload for one Bash command (Cursor `beforeShellExecution`, others `PreToolUse`). */
function payload(id: Id, command: string, cwd: string): Record<string, unknown> {
  const session_id = `fh-dir-${id}-${randomUUID()}`;
  if (id === "cursor") return { hook_event_name: "beforeShellExecution", session_id, command, cwd };
  return { hook_event_name: "PreToolUse", session_id, tool_use_id: randomUUID(), cwd, tool_name: "Bash", tool_input: { command } };
}

/** Permission decision from the host-specific hook stdout; empty stdout means allow. */
function decision(id: Id, stdout: string): string {
  if (!stdout) return "allow";
  const parsed = JSON.parse(stdout) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
  return id === "cursor" ? parsed.permission ?? "allow" : parsed.hookSpecificOutput?.permissionDecision ?? "allow";
}

test("real hook path: the directory is denied on every host; reads stay allowed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fh-dir-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "fh-dir-home-"));
  const h = join(home, ".fuse-harness");
  const rows: ReadonlyArray<readonly [string, string]> = [
    [`rm -rf ${h}`, "deny"], [`rm -r ${h}/`, "deny"], [`mv ${h} /tmp/fh-x`, "deny"], [`rmdir ${h}`, "deny"], [`mv ${h} ~/.Trash`, "deny"],
    [`ls ${h}`, "allow"], [`cat ${h}/config.json`, "allow"], [`du -sh ${h}`, "allow"], [`ls ${h}-old`, "allow"],
  ];
  for (const [command, expected] of rows) {
    const actual = await Promise.all(ids.map(async (id) => decision(id, (await handleHook(id, payload(id, command, cwd), { now: 1000, cwd, home })).stdout)));
    expect(actual, command).toEqual(ids.map(() => expected));
  }
});

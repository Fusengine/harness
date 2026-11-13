/**
 * rm on Codex/Kimi: the downgraded ask is a deny that (1) points to the trash
 * (`mv <target> ~/.Trash/`, which stays allowed) and (2) carries a one-time
 * CONFIRM code for exactly one real deletion. Roots, globs, variables, wrappers
 * and chained rms stay code-less; Claude Code keeps its native ask.
 *
 * Codex note: a receipt of the SAME tool_use_id re-allows idempotently within
 * the TTL (existing behaviour, fan-out safety); every call here uses a fresh
 * tool_use_id, so "one deletion" means one fresh tool call.
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleHook, type HandleOptions } from "../src/runtime/handle";
import { isIrreversible } from "../src/runtime/confirm/confirm-irreversible";
import { forgeryOf } from "./helpers/confirm-forgery";

const temp = (label: string): string => mkdtempSync(join(tmpdir(), `fh-${label}-`));
const pre = (s: string, command: string) => ({
  hook_event_name: "PreToolUse", session_id: s, tool_use_id: randomUUID(), tool_name: "Bash", tool_input: { command },
});
const submit = (s: string, prompt: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: s, prompt, ...extra });
const decision = (stdout: string): string => (stdout === "" ? "allow" : (JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? "allow"));
const codeOf = (stdout: string): string | undefined => stdout.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
const setup = () => ({ opts: { now: 1000, cwd: temp("rm-cwd"), home: temp("rm-home") } as HandleOptions, s: `rm-${randomUUID()}` });

for (const host of ["codex", "kimi"] as const) {
  describe(`${host}: rm is confirmable and points to the trash`, () => {
    test.each(["rm -rf trash/x", "rm -r trash/x", "rm -fr trash/x", "rm -Rf trash/x", "rm --recursive --force trash/x"])("%s -> deny with trash hint and a code", async (cmd) => {
      const { opts, s } = setup();
      const out = await handleHook(host, pre(s, cmd), opts);
      expect(decision(out.stdout)).toBe("deny");
      expect(out.stdout).toContain("mv trash/x ~/.Trash/");
      expect(out.stdout).toContain("no code needed");
      expect(out.stdout).toContain("DELETE: 'rm'");
      expect(codeOf(out.stdout)).toBeDefined();
    });

    test("the typed code authorizes exactly one real deletion", async () => {
      const { opts, s } = setup();
      const cmd = "rm -rf trash/x";
      const code = codeOf((await handleHook(host, pre(s, cmd), opts)).stdout) ?? "";
      await handleHook(host, submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
      expect(decision((await handleHook(host, pre(s, cmd), { ...opts, now: 1200 })).stdout)).toBe("allow");
      expect(decision((await handleHook(host, pre(s, cmd), { ...opts, now: 1300 })).stdout)).toBe("deny");
    });

    test("a code issued for one target never unlocks another", async () => {
      const { opts, s } = setup();
      const code = codeOf((await handleHook(host, pre(s, "rm -rf trash/x"), opts)).stdout) ?? "";
      await handleHook(host, submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
      expect(decision((await handleHook(host, pre(s, "rm -rf trash/y"), { ...opts, now: 1200 })).stdout)).toBe("deny");
    });

    test.each(["mv trash/x ~/.Trash/", "mv x ~/.Trash/"])("%s is allowed without any prompt", async (cmd) => {
      const { opts, s } = setup();
      expect(decision((await handleHook(host, pre(s, cmd), opts)).stdout)).toBe("allow");
    });

    test.each(["rm -rf /", "rm -rf ~", "rm -rf $HOME/x", "rm -rf /etc"])("%s -> still a deny, never a code", async (cmd) => {
      const { opts, s } = setup();
      const out = await handleHook(host, pre(s, cmd), opts);
      expect(decision(out.stdout)).toBe("deny");
      expect(codeOf(out.stdout)).toBeUndefined();
    });

    // Dot / double-slash spellings of a system or home directory (challenger round 1): never a code.
    test.each(["rm -rf /./usr", "rm -rf /./etc", "rm -rf /./Users", "rm -rf /./Users/me", "rm -rf /Users//me", "rm -rf /.//Users/me", "rm -rf /System/Library", "rm -rf /private/etc/x", "rm -rf /usr/local/x", "rm -rf /USERS", "rm -rf /users/me", "rm -rf /USERS/me/", "rm -rf /HOME/me", "rm -rf /APPLICATIONS/Safari.app", "rm -rf /library", "rm -rf /PRIVATE/var", "rm -rf /private/VAR", "rm -rf /USR", "rm -rf /ETC", "rm -rf /system/library/x", "rm -rf /tmp", "rm -rf /tmp/", "rm -rf /private/tmp", "rm -rf /cores", "rm -rf ./.", "rm -rf --no-preserve-root x", "rm -rf --preserve-root=no x"])("%s -> deny without a code", async (cmd) => {
      const { opts, s } = setup();
      const out = await handleHook(host, pre(s, cmd), opts);
      expect(decision(out.stdout)).not.toBe("allow");
      expect(codeOf(out.stdout)).toBeUndefined();
    });

    test.each(["rm -rf ~/x", "rm -rf ./a/./b", "rm -rf /Users/me/proj/x", "rm -rf /private/tmp/x", "rm -rf 'my dir'"])("%s -> confirmable (ordinary target)", async (cmd) => {
      const { opts, s } = setup();
      expect(codeOf((await handleHook(host, pre(s, cmd), opts)).stdout)).toBeDefined();
    });

    test.each(["rm -rf *", "sh -c 'rm -rf x'", "rm -rf a; rm -rf b", "rm -rf a && rm -rf b", "rm -rf x | cat", "echo y | xargs rm -rf", "rm -rf ~user/x", "rm -rf ../x", "rm -rf {a,b}", "rm -rf $X", "eval 'rm -rf x'"])("%s -> deny without a code", async (cmd) => {
      const { opts, s } = setup();
      const out = await handleHook(host, pre(s, cmd), opts);
      expect(decision(out.stdout)).toBe("deny");
      expect(codeOf(out.stdout)).toBeUndefined();
    });

    test("a non-literal target gets the generic trash hint", async () => {
      const { opts, s } = setup();
      expect((await handleHook(host, pre(s, "rm -rf *"), opts)).stdout).toContain("mv <path> ~/.Trash/");
    });

    test("find -delete gains no code", async () => {
      const { opts, s } = setup();
      expect(codeOf((await handleHook(host, pre(s, "find . -delete"), opts)).stdout)).toBeUndefined();
    });
  });
}

describe("unit: isIrreversible after the narrowing", () => {
  test.each([["rm -rf trash/x", false], ["rm -r trash/x", false], ["rm -rf /tmp/whatever", false], ["git stash; rm -rf /tmp/whatever", true], ["rm -rf *", true], ["sh -c 'rm -rf x'", true], ["rm -rf a; rm -rf b", true], ["rm -rf $HOME/x", true], ["rm -rf ~", true], ["rm -rf /", true], ["rm -rf ../x", true], ["rm -rf /./usr", true], ["rm -rf /USERS/me", true], ["rm -rf /tmp", true], ["rm -rf /private/tmp/x", false], ["rm -rf /Users//me", true], ["rm -rf /./Users/me", true], ["rm -rf x y", false], ["git push --force", true]] as const)("%s -> %p", (cmd, expected) => {
    expect(isIrreversible(cmd)).toBe(expected);
  });
});

describe("forgery: an agent cannot type the code for itself", () => {
  test("Codex sub-agent UserPromptSubmit carrying agent_id does not arm", async () => {
    const { opts, s } = setup();
    const code = codeOf((await handleHook("codex", pre(s, "rm -rf trash/x"), opts)).stdout) ?? "";
    await handleHook("codex", submit(s, `CONFIRM ${code}`, { agent_id: "child", agent_type: "worker" }), { ...opts, now: 1100 });
    expect(decision((await handleHook("codex", pre(s, "rm -rf trash/x"), { ...opts, now: 1200 })).stdout)).toBe("deny");
  });

  test.each([
    'codex exec resume abc-123 "CONFIRM ab12"',
    'codex exec resume --last "CONFIRM ab12"',
    'kimi --prompt "CONFIRM ab12"',
    'kimi --continue --prompt "confirm ab12"',
    'kimi -C -p "CONFIRM ab12"',
    'claude -p --resume abc "CONFIRM ab12"',
    "codex exec resume abc 'CONFIRM_ab12'",
    'codex exec resume abc "CONFIRM ab12\n"',
    'codex exec resume abc "CONFIRM ab12" --json',
    "kimi --prompt CONFIRM\\ ab12",
    'kimi --prompt "**CONFIRM ab12**"',
    "kimi --session s1 -p CONFIRM_ab12; true",
    "kimi --session s1 -p CONFIRM_ab12 && true",
    "kimi --session s1 -p CONFIRM_ab12 | cat",
    "kimi --session s1 -p CONFIRM_ab12 # note",
    "kimi --session s1 -p CONFIRM_ab12\ntrue",
    "printf CONFIRM_ab12 | codex exec resume --last -",
    "echo CONFIRM_ab12 | codex exec resume --last",
    'codex exec "CONFIRM $(echo ab12)"',
    'codex exec "CONFIRM ${X:-ab12}"',
    "codex exec \"$(printf 'CONFIRM %s' ab12)\"",
    "codex exec $'CONFIRM \\x61b12'",
    'codex exec "CONFIRM ab1$(:)2"',
    "printf 'CONFIRM ab12' | kimi",
  ])("Bash %s is blocked", (cmd) => expect(forgeryOf(cmd)).toBe("block"));

  test.each(['codex exec "confirm face detection works"', 'kimi -p "confirm 2025 deadline in README"', 'claude -p "summarise confirm-cafe flow"', "echo CONFIRM", "git commit -m 'confirm the plan'", 'echo "CONFIRM ab12"', "codex exec resume abc 'fix the tests'", "kimi --prompt 'list files'"])("Bash %s is not blocked", (cmd) => {
    expect(forgeryOf(cmd)).toBe("allow");
  });
});

describe("claude-code keeps its native ask", () => {
  test("rm -rf trash/x -> ask, no code, no hint", async () => {
    const { opts, s } = setup();
    const out = await handleHook("claude-code", pre(s, "rm -rf trash/x"), opts);
    expect(decision(out.stdout)).toBe("ask");
    expect(out.stdout).not.toContain("To allow");
    expect(codeOf(out.stdout)).toBeUndefined();
    expect(out.stdout).not.toContain(".Trash");
  });
});

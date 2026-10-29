/**
 * Visible CONFIRM feedback (UserPromptSubmit): on hosts with a context channel
 * (kimi raw stdout, codex additionalContext envelope) every typed CONFIRM code
 * gets an explicit acknowledgement — accepted, or unknown with the list of
 * pending codes (pendings never expire). Hosts without a verified channel (cursor, gemini-cli,
 * cline, hermes, claude-code) stay byte-identical, as does any prompt without
 * a CONFIRM code.
 */
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleHook, type HandleOptions } from "../src/runtime/handle";

const cwd = (): string => mkdtempSync(join(tmpdir(), "fh-cfb-cwd-"));
const home = (): string => mkdtempSync(join(tmpdir(), "fh-cfb-home-"));
const sid = (label: string): string => `${label}-${randomUUID()}`;

const pre = (id: string, s: string, command: string, toolUseId?: string, workdir?: string) => ({
  hook_event_name: "PreToolUse", session_id: s, tool_use_id: toolUseId ?? randomUUID(),
  ...(workdir ? { cwd: workdir } : {}), tool_name: "Bash", tool_input: { command },
});
const submit = (s: string, prompt: string) => ({ hook_event_name: "UserPromptSubmit", session_id: s, prompt });

function codeFromDeny(stdout: string): string {
  const code = stdout.match(/CONFIRM ([0-9a-f]{4})/i)?.[1];
  if (!code) throw new Error(`no CONFIRM code in: ${stdout}`);
  return code;
}

test("kimi: an accepted CONFIRM gets a visible acknowledgement naming the command", async () => {
  const h = home();
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: h };
  const s = sid("fb-kimi-ok");
  const cmd = "git commit -m feedback-kimi-ok";
  const deny = await handleHook("kimi", pre("kimi", s, cmd), opts);
  const code = codeFromDeny(deny.stdout);
  const out = await handleHook("kimi", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
  expect(out.stdout).toContain(`[fuse-harness] CONFIRM ${code} accepté pour : ${cmd} (valable 5 min)`);
});

test("kimi: an unknown code lists the pending codes with truncated commands", async () => {
  const h = home();
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: h };
  const s = sid("fb-kimi-unknown");
  const cmd = "git commit -m feedback-kimi-unknown";
  const deny = await handleHook("kimi", pre("kimi", s, cmd), opts);
  const code = codeFromDeny(deny.stdout);
  const wrong = code === "dead" ? "beef" : "dead";
  const out = await handleHook("kimi", submit(s, `CONFIRM ${wrong}`), { ...opts, now: 1100 });
  expect(out.stdout).toContain(`[fuse-harness] CONFIRM ${wrong} inconnu —`);
  expect(out.stdout).not.toContain("ou expiré"); // pendings never expire
  expect(out.stdout).toContain("codes en attente :");
  expect(out.stdout).toContain(`${code} (${cmd})`);
});

test("kimi: unknown code with nothing pending says so", async () => {
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: home() };
  const out = await handleHook("kimi", submit(sid("fb-kimi-none"), "CONFIRM dead"), opts);
  expect(out.stdout).toContain("[fuse-harness] CONFIRM dead inconnu —");
  expect(out.stdout).not.toContain("ou expiré");
  expect(out.stdout).toContain("codes en attente : aucun");
});

test("codex: an accepted CONFIRM rides the additionalContext envelope", async () => {
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("fb-codex-ok");
  const cmd = "git commit -m feedback-codex-ok";
  const deny = await handleHook("codex", pre("codex", s, cmd, "tool-a", workdir), opts);
  const code = codeFromDeny(deny.stdout);
  const out = await handleHook("codex", submit(s, `CONFIRM ${code}`), { ...opts, now: 1100 });
  const j = JSON.parse(out.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  expect(j.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
  expect(j.hookSpecificOutput?.additionalContext).toContain(`[fuse-harness] CONFIRM ${code} accepté — relance maintenant exactement : ${cmd} (valide 5 min)`);
});

test("codex: an unknown code answers 'inconnu' instead of staying silent", async () => {
  const h = home();
  const workdir = cwd();
  const opts: HandleOptions = { now: 1000, cwd: workdir, home: h };
  const s = sid("fb-codex-stale");
  const cmdA = "git push -u origin codex/stale-a";
  const cmdB = "git commit -m stale-b";
  const denyA = await handleHook("codex", pre("codex", s, cmdA, "tool-a", workdir), opts);
  const denyB = await handleHook("codex", pre("codex", s, cmdB, "tool-b", workdir), { ...opts, now: 1010 });
  const codeA = codeFromDeny(denyA.stdout);
  const codeB = codeFromDeny(denyB.stdout);
  // The incident's step 3: the FIRST code typed after the second denial.
  const out = await handleHook("codex", submit(s, `CONFIRM ${codeA}`), { ...opts, now: 1020 });
  // Post-fix A is still pending, so this is an ACCEPT; the stale case is covered by kimi above.
  expect(out.stdout).toContain(`[fuse-harness] CONFIRM ${codeA} accepté`);
  const wrong = codeB === "dead" ? "beef" : "dead";
  const unknown = await handleHook("codex", submit(s, `CONFIRM ${wrong}`), { ...opts, now: 1030 });
  expect(unknown.stdout).toContain(`[fuse-harness] CONFIRM ${wrong} inconnu —`);
  expect(unknown.stdout).not.toContain("ou expiré");
  expect(unknown.stdout).toContain(codeB);
});

test("kimi: an incidental code in a longer prompt stays silent (byte-identical output)", async () => {
  const h = home();
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: h };
  const s = sid("fb-incidental");
  for (const prompt of ["please confirm 2024 figures", "CONFIRMabcd x"]) {
    const out = await handleHook("kimi", submit(s, prompt), opts);
    expect(out.stdout).not.toContain("[fuse-harness] CONFIRM");
  }
});

test("kimi: an embedded code still ARMS silently (arming logic unchanged, no ack)", async () => {
  const h = home();
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: h };
  const s = sid("fb-embedded");
  const cmd = "git commit -m feedback-embedded";
  const deny = await handleHook("kimi", pre("kimi", s, cmd), opts);
  const code = codeFromDeny(deny.stdout);
  const out = await handleHook("kimi", submit(s, `ok, CONFIRM ${code} please`), { ...opts, now: 1100 });
  expect(out.stdout).not.toContain("[fuse-harness] CONFIRM"); // no ack for a non-anchored prompt…
  const allowed = await handleHook("kimi", pre("kimi", s, cmd), { ...opts, now: 1200 });
  expect(allowed.stdout).not.toContain('"permissionDecision":"deny"'); // …but the token IS armed, as before
});

test("a prompt WITHOUT a code emits no CONFIRM feedback (kimi + codex)", async () => {
  const h = home();
  const opts: HandleOptions = { now: 1000, cwd: cwd(), home: h };
  const kimi = await handleHook("kimi", submit(sid("fb-plain-k"), `ordinary prompt ${randomUUID()}`), opts);
  expect(kimi.stdout).not.toContain("[fuse-harness] CONFIRM");
  const codex = await handleHook("codex", submit(sid("fb-plain-c"), `ordinary prompt ${randomUUID()}`), opts);
  expect(codex.stdout).not.toContain("[fuse-harness] CONFIRM");
});

test("hosts without a verified UPS feedback channel stay byte-identical (gemini-cli, cline, hermes, claude-code)", async () => {
  for (const id of ["gemini-cli", "cline", "hermes", "claude-code"]) {
    const opts: HandleOptions = { now: 1000, cwd: cwd(), home: home() };
    const out = await handleHook(id, submit(sid(`fb-quiet-${id}`), "CONFIRM dead"), opts);
    expect(out.stdout).not.toContain("[fuse-harness] CONFIRM");
  }
});

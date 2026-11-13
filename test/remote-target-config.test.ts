import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remoteVerdict, tmpHome, withHome } from "./helpers/remote-verdict";

/** A fresh HOME whose `.ssh/config` holds `config` (and optional extra files relative to `.ssh/`). */
function homeWith(config: string, extra: Record<string, string> = {}): string {
  const home = tmpHome("rt-cfg-");
  mkdirSync(join(home, ".ssh", "conf.d"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), config);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(home, ".ssh", name), text);
  return home;
}
const CMD = "ssh prod 'sudo apt-get install -y nginx'";
const run = (config: string, extra?: Record<string, string>, cmd = CMD): string => withHome(homeWith(config, extra), () => remoteVerdict(cmd));

describe("ssh_config alias resolution: uncertain means NOT proven (today's verdict)", () => {
  test("a plain remote alias is proven", () => {
    expect(run("Host prod\n  HostName prod.example.com\n  User deploy\n")).toBe("allow");
    expect(run("Host *\n  ServerAliveInterval 30\n")).toBe("allow");
    expect(run("Host other\n  HostName localhost\n")).toBe("allow");
  });
  test.each([
    ["HostName localhost", "Host prod\n  HostName localhost\n"],
    ["HostName 127.0.0.1", "Host prod\n  HostName=127.0.0.1\n"],
    ["wildcard HostName local", "Host pr*\n  HostName 127.0.0.1\n"],
    ["ProxyCommand", "Host prod\n  ProxyCommand nc localhost 22\n"],
    ["ProxyJump", "Host prod\n  ProxyJump localhost\n"],
    ["LocalCommand", "Host prod\n  PermitLocalCommand yes\n  LocalCommand sudo x\n"],
    ["global ProxyCommand", "ProxyCommand nc %h 22\n"],
    ["Host * ProxyCommand", "Host *\n  ProxyCommand nc %h 22\n"],
    ["Match block", "Match host prod exec \"true\"\n  HostName localhost\n"],
    ["dynamic HostName", "Host prod\n  HostName %h.$USER\n"],
    ["quoted Host pattern", "Host \"prod\"\n  ProxyCommand nc localhost 22\n"],
    ["quoted HostName", "Host prod\n  HostName \"localhost\"\n"],
    ["CanonicalizeHostname", "CanonicalizeHostname yes\nHost prod.lan\n  HostName localhost\n"],
  ])("%s", (_n, cfg) => expect(run(cfg)).toBe("ask"));
  test("Include is followed; a local mapping inside is caught", () => {
    expect(run("Include conf.d/*\n", { "conf.d/a": "Host prod\n  HostName localhost\n" })).toBe("ask");
    expect(run("Include conf.d/*\n", { "conf.d/a": "Host prod\n  HostName prod.example.com\n" })).toBe("allow");
    expect(run("Host z\n  Include nothing-here\n")).toBe("allow");
    expect(run("Include conf.d/[a]*\n", { "conf.d/a": "Host prod\n  HostName localhost\n" })).toBe("ask");
    expect(run("CanonicalizeHostname no\nHost prod\n  HostName prod.example.com\n")).toBe("allow");
  });
  test("an unreadable config is not proof", () => {
    const home = homeWith("");
    mkdirSync(join(home, ".ssh", "config2"));
    writeFileSync(join(home, ".ssh", "config"), "Include config2\n");
    expect(withHome(home, () => remoteVerdict(CMD))).toBe("ask");
  });
});

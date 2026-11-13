import { describe, expect, test } from "bun:test";
import { payloadAllowed } from "../src/policy/remote-target-payload";
import { lookupInChild } from "../src/policy/remote-target-resolve";

describe("payloadAllowed (allowlist gate, decision 22:35)", () => {
  test.each([
    "sudo apt-get install -y nginx", "echo x | sudo tee -a /etc/hosts", "sudo rm -rf /var/www/old", "sudo chown -R deploy /srv/app",
    "sudo chmod -R 755 /var/www/site", "chown deploy /srv/app", "sudo ufw allow 443 && sudo ufw enable", "systemctl restart nginx",
    "rm -f /tmp/x.log", "sudo rm -rf /srv/app/releases/old /srv/app/cache", "docker run --rm alpine true",
  ])("allowed: %s", (p) => expect(payloadAllowed(p)).toBe(true));
  test.each([
    "echo x | sh", "echo x | bash -s", "echo x | sudo sh", "echo x | sudo -n bash", "echo x | /bin/dash", "echo x | xargs sh -c",
    "echo cm0= | base64 -d", "xxd -r -p f", "openssl enc -d -a", "find /x -exec rm {} ;", "find /x -execdir rm {} ;",
    "env -C / rm -rf /x/y", "sudo env --chdir=/ ls", "sudo -D / ls", "ln -s / /tmp/r", "ln -sf a b", "eval x", "echo $(id)", "echo `id`",
    "cd /srv/app && rm -rf old", "cd /srv/app && chown -R a /x/y", "pushd /x/y; chmod -R 777 /x/y",
    "rm -rf /", "rm -rf /etc", "rm -rf /var", "rm -rf /*", "rm -rf /var/*", "rm -rf $DIR", "rm -rf ~/x", "rm -rf build", "rm -rf /a/../b",
    "rm", "sudo chown -R app:app uploads", "chown -R a /", "chown -R a /etc", "chmod -R -x /", "chown -R --reference=/x /",
  ])("refused: %s", (p) => expect(payloadAllowed(p)).toBe(false));
});

describe("resolveHost (real local lookup in a child, 300 ms ceiling)", () => {
  test("loopback name resolves to a loopback address; an unknown name is no-such-host or failure", () => {
    const lo = lookupInChild("localhost");
    expect(lo).not.toBeNull(); // the child must really work, or the feature silently never relaxes anything
    expect(lo?.some((a) => a === "127.0.0.1" || a === "::1")).toBe(true);
    const nx = lookupInChild("no-such-host.invalid");
    expect(nx === null || nx.length === 0).toBe(true);
  });
});

import { hostname } from "node:os";
import { describe, expect, test } from "bun:test";
import { remoteVerdict, tmpHome, withHome } from "./helpers/remote-verdict";

const home = tmpHome("rt-home-");
const v = (c: string): string => withHome(home, () => remoteVerdict(c));
const own = hostname();

describe("not proven remote, or catastrophic: today's verdict is kept", () => {
  const KEPT: Array<[string, string]> = [
    ["sudo tee /etc/hosts < hosts.new", "block"],
    ["sudo apt-get install -y x", "block"],
    ["ssh localhost 'sudo tee /etc/x'", "ask"],
    ["ssh 127.0.0.1 'sudo apt-get install -y nginx'", "ask"],
    ["ssh 127.1 'sudo apt-get install -y nginx'", "ask"],
    ["ssh 0.0.0.0 'sudo apt-get install x'", "ask"],
    ["ssh ::1 'sudo apt-get install x'", "ask"],
    ["ssh localhost.localdomain 'sudo apt-get install x'", "ask"],
    ["ssh me@box.localhost 'sudo apt-get install x'", "ask"],
    ["ssh $(hostname) 'sudo rm -rf /var/www/old'", "block"],
    ["ssh `hostname` 'sudo apt-get install x'", "ask"],
    ["ssh $H 'sudo apt-get install x'", "ask"],
    [`ssh ${own} 'sudo apt-get install x'`, "ask"],
    [`ssh me@${own.split(".")[0]} 'sudo apt-get install x'`, "ask"],
    ["ssh -o ProxyCommand='nc localhost 22' host 'sudo apt-get install -y x'", "ask"],
    ["ssh -oProxyJump=localhost host 'sudo apt-get install -y x'", "ask"],
    ["ssh -J localhost host 'sudo apt-get install -y x'", "ask"],
    ["ssh -F /tmp/cfg host 'sudo apt-get install x'", "ask"],
    ["ssh -o Hostname=localhost host 'sudo apt-get install x'", "ask"],
    ["ssh -o PermitLocalCommand=yes -o LocalCommand=true host 'sudo apt-get install -y x'", "ask"],
    ["scp x localhost:/etc/x", "allow"],
    ["ssh host 'sudo rm -rf /'", "ask"],
    ["ssh host 'rm -rf /*'", "ask"],
    ["ssh host 'a; sudo r\"\"m -rf /'", "block"],
    ["ssh host 'a; sudo r\\m -rf /etc'", "block"],
    ["ssh host 'sudo chown -R root /'", "ask"],
    ["ssh 127.0.0.1.nip.io 'sudo apt-get install x'", "ask"],
    ["ssh h bash -s <<'EOF'\nls\nEOF\nsudo rm -rf /etc/nginx\nEOF=1", "block"],
    ["ssh h 'sudo chown -R --reference=/x /'", "ask"],
    ["ssh h 'sudo chown -R root /etc'", "ask"],
    ["ssh h 'cd / && sudo rm -rf etc'", "block"],
    ["ssh h 'cd /usr && sudo rm -rf lib'", "block"],
    ["ssh h 'sudo rm -rf /Users/bob'", "ask"],
    ["ssh h 'sudo rm -rf /Library'", "ask"],
    ["ssh h 'sudo rm -rf /etc/nginx'", "block"],
    ["ssh h 'sudo rm -rf /var/www/old /etc'", "block"],
    ["ssh h 'sudo rm -rf --no-preserve-root /srv/x'", "ask"],
    ["ssh h 'sudo find / -name x | xargs rm -f'", "ask"],
    ["ssh -o UserKnownHostsFile=/etc/sudoers.d/x h 'sudo apt-get install x'", "ask"],
    ["ssh host 'sudo rm -rf /var'", "block"],
    ["ssh host 'sudo rm -rf /etc/nginx/*'", "block"],
    ["ssh host 'rm -rf $DIR'", "ask"],
    ["ssh host 'mkfs.ext4 /dev/sda1'", "block"],
    ["ssh host 'dd if=/dev/zero of=/dev/sda'", "block"],
    ["ssh host ':(){ :|:& };:'", "block"],
    ["ssh host 'x' > /etc/hosts", "ask"],
    ["ssh host 'cmd'; sudo rm -rf /etc", "block"],
    ["ssh host 'sudo apt-get install -y x' && sudo apt-get install -y y", "block"],
    ["ssh host sudo ufw allow 443 && sudo ufw enable", "block"],
    ["echo ssh host 'sudo rm -rf /etc/x'", "block"],
    ["ssh host 'sudo apt-get install \"x", "ask"],
    [`ssh host "echo $(sudo rm -rf /etc)"`, "block"],
    ["PATH=/tmp:$PATH ssh host 'sudo apt-get install x'", "ask"],
  ];
  test.each(KEPT)("%s -> %s", (c, kind) => expect(v(c)).toBe(kind));
});

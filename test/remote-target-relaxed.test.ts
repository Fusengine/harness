import { describe, expect, test } from "bun:test";
import { remoteVerdict, tmpHome, withHome } from "./helpers/remote-verdict";

const home = tmpHome("rt-home-");
const v = (c: string): string => withHome(home, () => remoteVerdict(c));

describe("proven remote host, whole command = one simple ssh: no opinion on the payload", () => {
  const RELAXED = [
    "ssh user@host 'sudo apt-get install -y nginx'",
    "ssh user@host 'sudo tee /etc/nginx/sites-available/app' < app.conf",
    `ssh user@host "cat > /etc/app.conf" < app.conf`,
    `ssh user@host 'echo "x" | sudo tee -a /etc/hosts'`,
    "ssh user@host 'sudo ufw allow 443 && sudo ufw enable'",
    "ssh user@host 'sudo useradd deploy && sudo mkdir -p /srv/app && sudo chown deploy /srv/app'",
    "ssh user@host 'sudo rm -rf /var/www/old'",
    "ssh user@host 'sudo chown -R deploy /srv/app'",
    "ssh user@host 'sudo chmod -R 755 /var/www/site'",
    "ssh user@host 'brew install jq'",
    "ssh user@host 'pip install requests'",
    `ssh user@host "sudo apt-get install -y nginx"`,
    "ssh user@host 'sudo apt-get ''install'' x'",
    "ssh user@host 'sudo tee /etc/nginx/x' < app.conf",
    "ssh user@host 'bash -s' < setup.sh",
    "ssh user@host 'sudo apt-get install -y nginx' < ./dir/in-1.txt",
    "ssh -p 2222 -i /home/me/.ssh/k -o StrictHostKeyChecking=no deploy@203.0.113.9 'sudo apt-get install -y nginx'",
    "ssh -tt host 'sudo rm -rf /srv/app/old'",
    "ssh -l root -oBatchMode=yes -o ConnectTimeout=5 host.example.com 'sudo dnf install -y x'",
    "ssh -4 -A -q -v -T root@203.0.113.7 'apt-get install -y x'",
    "ssh h 'sudo rm -rf /etc/nginx/sites-enabled/old'",
    "rsync -av --rsync-path='sudo rsync' conf/ user@host:/etc/app/",
  ];
  test.each(RELAXED)("allow: %s", (c) => expect(v(c)).toBe("allow"));
});

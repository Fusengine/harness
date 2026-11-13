import { describe, expect, test } from "bun:test";
import { payloadCatastrophic } from "../src/policy/remote-target-danger";
import { remoteLocalView } from "../src/policy/remote-target";
import { remoteVerdict, tmpHome, withHome } from "./helpers/remote-verdict";

const home = tmpHome("rt-parse-");
const view = (c: string): string | null => withHome(home, () => remoteLocalView(c));
const v = (c: string): string => withHome(home, () => remoteVerdict(c));

describe("local view", () => {
  test("only the proven-remote payload is cut", () => {
    expect(view("ssh h 'sudo x'")).toBe("ssh h __REMOTE_COMMAND__");
    expect(view("ssh -p 22 h 'sudo apt-get install -y x' < in.sh")).toBe("ssh -p 22 h __REMOTE_COMMAND__ < in.sh");
    expect(view(`ssh h "cat > /etc/app.conf"`)).toBe("ssh h __REMOTE_COMMAND__");
    expect(view("ssh h 'a' 'b'")).toBeNull();
  });
  test.each([
    "ssh h 'sudo x' > /etc/hosts", "ssh h 'a'; sudo rm -rf /etc", "ssh h 'x' 2>&1 | tee /etc/log", "ssh h sudo ufw allow 443 && sudo ufw enable",
    "ssh h\nsudo reboot", "ssh h 'x' | sh", "ssh h 'x' > /tmp/r.sh; sh /tmp/r.sh", "ssh h 'x' ;", "ssh h 'x' &", "ssh h 'x' # c", "X=1 ssh h 'x'",
    "ssh h 'x' < a < b", "ssh h 'x' >> f", "ssh h 'x' 2> f", "< f ssh h 'x'", "functions[ssh]='sh -c \"$2\"'; ssh h 'x'", ". ./defs.sh; ssh h 'x'",
    "read PATH <<< /tmp/e; ssh h 'x'", "ssh h bash -s <<'EOF'\nx\nEOF", "ssh h -t 'x'", "ssh -- h 'x'", "ssh -N h 'x'", "ssh -J a h 'x'",
    "ssh -o UserKnownHostsFile=/dev/null h 'x'", "ssh -o ControlPath=/tmp/m h 'x'", "ssh evil.example.com 'x'", "ssh v6.example.com 'x'",
    "ssh slow.example.com 'x'", "ssh localho.st 'x'", "ssh h {-oProxyCommand=x,y}", "ssh -i {k,localhost} env 'sudo apt-get install x'",
    "ssh h $X y", "ssh h * y", "ssh h 'x' < ${a[b]}", "ssh h 'x' < $f", "ssh h 'x' < `x`", "ssh h 'x' < <(echo f)", "ssh h 'x' < ~/x",
    "ssh h 'x' < f*", "ssh h 'x' < =ls", "ssh h 'x' < \"$f\"", "ssh h 'x' < f{a,b}", "ssh -i $K h 'x'", "ssh -p $((1)) h 'x'", "ssh host$X 'x'",
    "ssh -i ~/k h 'x'", "ssh -o Port=2$X h 'x'", "ssh h\\ x 'y'", "ssh -l r\\oot h 'x'", "ssh $SSH h 'x'", "ssh h 'x' < a!b", "ssh h 'x' < a?b", "ssh h sudo apt-get install x", "ssh h \"a $(id)\"", "ssh h \"a `id`\"", "ssh h \"a ${x}\"", "ssh h $'a b'",
    "ssh h \"a \\\"b\\\"\"", "ssh h 'a'\"$b\"", "ssh h \"a !b\"", "ssh h \"a $b\"",
    "ssh u@example.com true \"${d:=\\$}${x:=a[${d}( sudo id )]}$[x]\"", "ssh -p $P h 'x'", "ssh -o User=$U h 'x'",
  ])("outside the one-simple-ssh shape: %s", (c) => expect(view(c)).toBeNull());
  test.each([
    "ssh localhost 'x'", "echo ssh h 'x'", "ssh h 'x", "ssh h \"$(cmd)\"", "ssh h `cmd`", "ssh h 'x' <(cmd)", "ssh h 'a' \\\n 'b'",
    "(ssh h 'x')", "ssh h $'x'", "ssh -Z h 'x'", "ssh -o Foo=1 h 'x'", "ssh h", "ssh", "ssh -p", "PATH=/tmp:$PATH ssh h 'x'",
    "alias ssh=true; ssh h 'x'", "ssh h 'x' > f 'y'", "ssh $H 'x'", "ssh 'h'$X 'x'", "ssh h 'x' <<EOF\nbody", "ssh ~ 'x'",
  ])("not cleanly extractable or not proven: %s", (c) => expect(view(c)).toBeNull());
});

describe("heredocs are outside the allowed shape (today's verdict)", () => {
  test("no relaxation", () => {
    expect(v("ssh h bash -s <<'EOF'\nsudo apt-get install -y nginx\nsudo tee /etc/x\nEOF")).toBe("ask");
    expect(v("ssh h <<EOF\napt-get install -y nginx\nEOF")).toBe("ask");
    expect(v("ssh h 'bash -s' <<-EOF\n\tpip install requests\n\tEOF")).toBe("ask");
  });
  test("a body expanded by the local shell, or fed to a local command, is not remote", () => {
    expect(v("ssh h bash -s <<EOF\nsudo $(apt-get install x)\nEOF")).toBe("ask");
    expect(v("cat <<EOF\napt-get install x\nEOF")).toBe("ask");
    expect(v("ssh localhost bash -s <<EOF\napt-get install x\nEOF")).toBe("ask");
  });
});

describe("payloadCatastrophic", () => {
  test.each([
    "rm -rf /", "rm -rf /*", "sudo rm -rf /etc", "rm -rf /var", "rm -rf ~", "rm -rf ~/", "rm -rf $DIR", "rm -rf /srv/*", "rm -rf ..",
    "rm -rf .", "rm -rf /home", "rm -rf --no-preserve-root /x", "find /x | xargs rm", "bash -c \"rm -rf /\"", "rm -rf a /",
    "sudo chown -R deploy /", "chmod -R 777 /etc", "rm -rf /var/../etc", "rm -rf /usr/local",
    "sudo r$()m -rf /", "sudo r${x}m -rf /", "sudo r\\\nm -rf /", "r\"\"m -rf /", "$RM -rf x", "sudo $(which rm) -rf /x/y",
    "sudo chmod -R -x /", "sudo chown -R --reference=/x /", "cd / && sudo rm -rf etc", "cd /usr && rm -rf lib", "rm -rf /Users/bob",
  ])("catastrophic: %s", (p) => expect(payloadCatastrophic(p)).toBe(true));
  test.each([
    "rm -rf /var/www/old", "sudo rm -rf /srv/app/old && ls", "rm -f /tmp/x.log", "rm -rf ~/old", "rm -rf build", "apt-get install x",
    "chown -R deploy /srv/app", "chmod -R 755 /var/www/site", "rm -rf /opt/app", "cd /srv/app && sudo rm -rf releases/old",
    "apt-get install -y pkg-$(uname -m)", "apt-get install -y $PKG", "chown -R app:app uploads", "rm -rf /Users/bob/old/dir",
  ])("named path: %s", (p) => expect(payloadCatastrophic(p)).toBe(false));
});

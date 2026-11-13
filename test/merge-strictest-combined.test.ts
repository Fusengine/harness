import { afterAll, describe, expect, test } from "bun:test";
import { securityGuard } from "../src/policy/guards/security";
import { gitCommitDir } from "../src/runtime/git-commit-command";
import { gitSubcommand } from "../src/policy/release-command";
// Side effect: the shared deterministic resolver (an unknown name such as `h` does not exist locally, so it is a literal non-loopback host).
import { remoteVerdict } from "./helpers/remote-verdict";
/** Verdict of the security guard for one Bash command. */
const verdict = (command: string): string => securityGuard({ tool: "Bash", command })?.kind ?? "allow";

const savedProjectDir = process.env["CLAUDE_PROJECT_DIR"];
process.env["CLAUDE_PROJECT_DIR"] = process.cwd();
afterAll(() => {
  if (savedProjectDir === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
  else process.env["CLAUDE_PROJECT_DIR"] = savedProjectDir;
});

describe("heredoc fed to ssh gets the full local judgment (f4), never the proven-remote relaxation", () => {
  const BODIES: [string, string][] = [
    ["rm -rf /etc/x", "block"], ["sudo ls", "block"], ["rm -rf build", "ask"], ["rm -rf /usr/local/x", "block"],
    ["chown -R a:b x", "ask"], ["rm -rf ~/.Trash/x /tmp/y", "ask"],
  ];
  for (const host of ["localhost", "127.0.0.1"]) {
    for (const [body, want] of BODIES) {
      test(`${host}: ${body} -> ${want}`, () => {
        expect(verdict(`ssh ${host} sh <<'EOF'\n${body}\nEOF`)).toBe(want);
      });
    }
  }
  test("a heredoc fed to a literal NON-loopback host keeps the installed verdict (ask, never a new block)", () => {
    expect(remoteVerdict("ssh h bash -s <<'EOF'\nsudo apt-get install -y nginx\nsudo tee /etc/x\nEOF")).toBe("ask");
    // Whole local chain (security, then install), as the installed build answers it: the install guard asks on the apt-get.
    expect(remoteVerdict("ssh 93.184.216.34 bash -s <<'EOF'\nsudo apt-get install -y nginx\nEOF")).toBe("ask");
  });
  test("an unresolvable literal host (ssh_config alias) is not proven local: installed verdict, never a new block", () => {
    // The shared test resolver times out (null) on slow.example.com, like a real lookup of an ~/.ssh/config alias.
    expect(remoteVerdict("ssh slow.example.com bash -s <<'EOF'\nsudo apt-get install -y nginx\nsudo tee /etc/x\nEOF")).toBe("ask");
  });
  test("a name that resolves to loopback is proven local: full judgment", () => {
    expect(verdict("ssh evil.example.com sh <<'EOF'\nsudo ls\nEOF")).toBe("block");
  });
  test("a proven-remote single-quoted payload stays relaxed (01b99bd)", () => {
    expect(verdict("ssh deploy@93.184.216.34 'rm -rf /etc/nginx/sites/x'")).toBe("allow");
    expect(verdict("ssh deploy@93.184.216.34 'sudo rm -rf /srv/app/cache'")).toBe("allow");
  });
});

describe("commit trigger: wrapper grammar keeps every 7315804 form and the combined-only ones", () => {
  const fires = (c: string): boolean => gitCommitDir(c, process.cwd()) !== null && gitSubcommand(c)?.sub === "commit";
  const BOTH: string[] = [
    "env - git commit -m x", "env -i - git commit -m x", "xargs --replace git commit -m x", "xargs --eof git commit -m x",
    "xargs --replace=R git commit -m x", "env -u FOO git commit -m x", "nice -n 5 git commit -m x", "timeout -s KILL 5 git commit -m x",
    "sudo -u root git commit -m x", "xargs -I {} git commit -m x", "exec -a n git commit -m x", "stdbuf -o L git commit -m x",
    "ionice -c 3 git commit -m x", "xargs -E x git commit -m x", "time -o f git commit -m x", "env -C . git commit -m x",
  ];
  for (const c of BOTH) test(c, () => expect(fires(c)).toBe(true));
});

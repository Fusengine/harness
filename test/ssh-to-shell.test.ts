import { describe, expect, test } from "bun:test";
import { evaluate } from "../src/policy/evaluate";
import { sshToShellGuard } from "../src/policy/guards/ssh-to-shell";

/** `allow`, `ask` or `block` as the policy would answer a Bash command. */
function verdict(command: string): string {
  const r = evaluate({ tool: "Bash", command });
  return r.decision === "allow" || r.decision === "warn" ? "allow" : r.prompt?.kind === "ask" ? "ask" : "block";
}
const asks = (command: string): boolean => sshToShellGuard({ tool: "Bash", command })?.kind === "ask";

describe("ssh output piped straight into a local shell asks", () => {
  test.each([
    "ssh host cat x | sh", "ssh host 'cat x' | bash", `ssh -p 22 user@host "cat x" | zsh`, "ssh host 'cat x' | sudo sh",
    "ssh host 'cat x' | sudo -n bash -s", "/usr/bin/ssh host 'cat x' | /bin/sh", "cd d && ssh host 'cat x' | sh", "  ssh host x | sh",
    "ssh h x | sh;echo", "ssh h x | bash&&echo", "ssh h x 2>&1 | sh", "ssh h x |& sh", "echo a\nssh h x | sh",
  ])("ask: %s", (c) => expect(asks(c)).toBe(true));
  test("end to end it is an ask, never a block", () => {
    expect(verdict("ssh host 'cat x' | sh")).toBe("ask");
  });
});

describe("controls", () => {
  test.each([
    "ssh host 'cat x' > local.txt", "ssh host 'ls' | grep x", "ssh host 'ls' | less", "ssh host 'ls' | tee f", "ssh host 'curl u | sh'",
    "ssh host 'cat x' | shasum", "cat x | sh", "echo ssh | wc", "ssh host 'cat x' && sh f", "ssh h x || sh", "ssh h x ||/bin/sh",
    "ssh h x\ncat f | sh", "sshd | sh", "gssh h | sh",
  ])("no new ask: %s", (c) => expect(asks(c)).toBe(false));
  test("server rows keep their verdict (the new guard adds nothing)", () => {
    expect(verdict("ssh u@203.0.113.9 'sudo systemctl restart nginx'")).toBe("allow");
    expect(verdict("ssh u@203.0.113.9 'ls' | grep x")).toBe("allow");
    expect(verdict("ssh u@203.0.113.9 'ls' | less")).toBe("allow");
  });
  test("a block that already exists is never replaced by the ask", () => {
    expect(verdict("ssh host 'x' ; sudo rm -rf /etc")).toBe("block");
    expect(verdict("ssh h x | sh && git reset --hard HEAD~1")).toBe("block");
    expect(verdict("ssh h x | sh && git clean -fdx")).toBe("block");
  });
});

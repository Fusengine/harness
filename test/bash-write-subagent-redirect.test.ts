import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fh-subredir-")));
const D = join(root, "claude-501", "-proj", "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", "scratchpad");
mkdirSync(D, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The real command of the 286-min stall (agent-a50890745b3204ccd, 2026-11-13): mkdir, a `{ }` group, backslashes, `f=`. */
const REAL = `f=/x/tool-results/b2h603hkm.txt; s=${D}; mkdir -p $s; { grep -E '^\\?\\? (Apps|Sources|Tests)/' $f; grep -E '^\\?\\? docs/reports/ios-ux-polish/.*\\.md$' $f; } | sed 's/^?? //' > $s/untracked-stage.txt; wc -l < $s/untracked-stage.txt; echo names-done`;

type Verdict = "allow" | "ask" | "block";
/** Verdict of the Bash write guard (and the text a blocked agent reads), optionally as a sub-agent. */
function v(command: string, agentId?: string): { kind: Verdict; reason: string } {
  const r = bashWriteGuard({ tool: "Bash", command, scratchpadDir: D, agentId });
  return r === null ? { kind: "allow", reason: "" } : { kind: r.kind === "ask" ? "ask" : "block", reason: `${r.reason} ${(r.actions ?? []).join(" ")}` };
}

describe("a file redirect nobody can confirm becomes a block with the exact way out", () => {
  test("real stalled command: main session asks, sub-agent is blocked with instructions", () => {
    expect(v(REAL).kind).toBe("ask");
    const sub = v(REAL, "agent-a50890745b3204ccd");
    expect(sub.kind).toBe("block");
    expect(sub.reason).toContain("Write tool");
    expect(sub.reason).toContain("scratchpad");
    expect(sub.reason).toMatch(/plain .*redirect/);
  });
  test("a redirect outside the scratchpad is blocked for a sub-agent, still asked in the main session", () => {
    const cmd = "ls /etc | sort > /Users/someone/outside.txt";
    expect(v(cmd).kind).toBe("ask");
    expect(v(cmd, "agent-1").kind).toBe("block");
  });
  test("the suggested full-path form is accepted for a read-only command and a git report", () => {
    expect(v(REAL, "agent-1").reason).toContain(`> ${D}/file`);
    expect(v(`ls -la > ${D}/file`, "agent-1").kind).toBe("allow");
    expect(v(`git status > ${D}/file`, "agent-1").kind).toBe("allow");
  });
  test("negative control: what is silent stays silent for a sub-agent", () => {
    expect(v(`S=${D}; echo x > $S/a.txt`, "agent-1").kind).toBe("allow");
    expect(v(`s=${D}; echo x > $s/a.txt`, "agent-1").kind).toBe("allow");
    expect(v("ls -la", "agent-1").kind).toBe("allow");
    expect(v("echo x > /dev/null", "agent-1").kind).toBe("allow");
  });
});

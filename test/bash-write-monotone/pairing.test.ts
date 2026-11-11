/**
 * PAIRING rule: command output from an allowlisted producer may land in a temp file (step 1), but
 * the follow-up cp/mv/install/ln of that temp file onto a code file (step 2) must be DENIED on
 * claude-code, codex, kimi and cursor — bare, after `cd d &&`, and inside compound bodies. The temp
 * allow must never ship without this rule. (Under `sh -c` / `eval` / pipes the same rule is covered
 * by the wrapper-descent deliverable: pairing-wrappers.test.ts.)
 */
import { describe, expect, test } from "bun:test";
import type { Atom } from "../helpers/monotone-atoms";
import { COMPOUND_IDS, execCases } from "../helpers/monotone-contexts";
import { HOSTS, hostDecision } from "../helpers/monotone-verdict";

const PRODUCERS = ["ls > /tmp/x", "git diff > /tmp/fh-x.txt", "cat README.md > /tmp/fh-y"];
const FOLLOWUPS: readonly Atom[] = [
  { id: "cp", cmd: "cp /tmp/x t.ts", multiline: false, gap: true },
  { id: "mv", cmd: "mv /tmp/x t2.ts", multiline: false, gap: true },
  { id: "cp-fh", cmd: "cp /tmp/fh-x.txt src/x.ts", multiline: false, gap: true },
  { id: "mv-fh", cmd: "mv /tmp/fh-y src/x.ts", multiline: false, gap: true },
  { id: "install", cmd: "install -m 644 /tmp/fh-x.txt src/x.ts", multiline: false, gap: true },
  { id: "ln", cmd: "ln -sf /tmp/fh-x.txt src/x.ts", multiline: false, gap: true },
  { id: "chained", cmd: "ls > /tmp/x && cp /tmp/x t.ts", multiline: false, gap: true },
  { id: "chained-mv", cmd: "git diff > /tmp/fh-x.txt; mv /tmp/fh-x.txt src/x.ts", multiline: false, gap: true },
];

describe("step 1: allowlisted producer to temp is allowed", () => {
  for (const cmd of PRODUCERS) {
    test(cmd, async () => {
      expect(await hostDecision("claude-code", cmd)).toBe("allow");
    });
  }
});

describe("step 2: temp file onto a code file is denied on every host", () => {
  for (const host of HOSTS) {
    for (const atom of FOLLOWUPS) {
      test(`${host}: ${atom.id}`, async () => {
        const compound = execCases([atom], 1).filter((c) => c.chain[0] && COMPOUND_IDS.has(c.chain[0].id));
        const cases = [
          { cmd: atom.cmd, name: "bare" },
          { cmd: `cd d && ${atom.cmd}`, name: "cd d &&" },
          ...compound.map((c) => ({ cmd: c.cmd, name: c.chain[0]?.id ?? "?" })),
        ];
        const bad: string[] = [];
        for (const c of cases) {
          const d = await hostDecision(host, c.cmd);
          if (d !== "deny") bad.push(`${d}: ${c.name}`);
        }
        expect(bad).toEqual([]);
      });
    }
  }
});

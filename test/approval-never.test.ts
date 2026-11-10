import { test, expect } from "bun:test";
import { evaluate } from "../src/policy/evaluate";
import type { PolicyContext } from "../src/policy/interfaces/types";

const never = (command: string): PolicyContext => ({ tool: "Bash", command, neverApproval: true });

test("neverApproval: RALPH_SAFE subset auto-approves with a visible warn + notice", () => {
  const r = evaluate(never("git commit -m x"));
  expect(r.decision).toBe("warn");
  expect(r.prompt?.kind).toBe("inform");
  expect(r.prompt?.userMessage).toContain("Auto-approved");
  expect(r.prompt?.userMessage).toContain("approval_policy=never");
  expect(r.prompt?.actions).toContain("Or set RALPH_MODE=1 to auto-approve silently (no notice)");
});

test("neverApproval absent/false: byte-identical to the pre-existing ask deny", () => {
  const withFlag = evaluate({ tool: "Bash", command: "git commit -m x", neverApproval: false });
  const withoutFlag = evaluate({ tool: "Bash", command: "git commit -m x" });
  expect(withFlag).toEqual(withoutFlag);
  expect(withoutFlag.decision).toBe("deny");
  expect(withoutFlag.prompt?.kind).toBe("ask");
});

test("neverApproval never exempts a destructive command — still a hard block", () => {
  const r = evaluate(never("git push --force"));
  expect(r.decision).toBe("deny");
  expect(r.prompt?.kind).toBe("block");
});

test("neverApproval does not touch commands outside NEVER_SAFE (checkout still asks)", () => {
  const r = evaluate(never("git checkout main"));
  expect(r.decision).toBe("deny");
  expect(r.prompt?.kind).toBe("ask");
});

test("RALPH_MODE takes priority over neverApproval: silent allow, no notice", () => {
  process.env.RALPH_MODE = "1";
  try {
    const r = evaluate(never("git commit -m x"));
    expect(r.decision).toBe("allow");
    expect(r.prompt).toBeUndefined();
  } finally {
    delete process.env.RALPH_MODE;
  }
});

test("neverApproval anti-chaining: a chained destructive command still hard-blocks", () => {
  const r = evaluate(never("git commit -m x && git push --force"));
  expect(r.decision).toBe("deny");
  expect(r.prompt?.kind).toBe("block");
});

test("neverApproval anti-chaining: a chained safe command falls through to the normal ask, never warn", () => {
  const r = evaluate(never("git commit -m x; rm -rf /tmp/x"));
  expect(r.decision).toBe("deny");
  expect(r.prompt?.kind).toBe("ask");
});

test("neverApproval anti-chaining: a single background & separates commands — ask, never warn", () => {
  const r = evaluate(never("git add . & git push"));
  expect(r.decision).toBe("deny");
  expect(r.prompt?.kind).toBe("ask");
});

// Target is /dev/null: `&> /tmp/out.txt` used to pass only because bash-write ignored `&>` (the bug fixed in
// bash-write-amp-redirect.test.ts); a real file write now asks exactly like `> /tmp/out.txt`.
test("neverApproval: bash &> redirect is NOT chaining — still auto-approves", () => {
  const r = evaluate(never("git commit -m x &> /dev/null"));
  expect(r.decision).toBe("warn");
  expect(r.prompt?.kind).toBe("inform");
});

test("neverApproval: `&>` to a real file asks, exactly like `>`", () => {
  const amp = evaluate(never("git commit -m x &> /tmp/out.txt"));
  const plain = evaluate(never("git commit -m x > /tmp/out.txt"));
  expect(amp.decision).toBe(plain.decision);
  expect(amp.prompt?.kind).toBe(plain.prompt?.kind);
  expect(amp.prompt?.kind).toBe("ask");
});

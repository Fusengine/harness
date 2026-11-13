import { test, expect } from "bun:test";
import { ALL_RULES, CRITICAL_RULES, SKIP_LIST } from "../src/codex-rules";

const RM_LABEL = "DELETE: 'rm' permanently deletes - confirmation required";
const RM_BINARIES = new Set(["rm", "/bin/rm", "/usr/bin/rm"]);

test("no prompt rule targets rm, /bin/rm or /usr/bin/rm (hook owns rm via CONFIRM + trash hint)", () => {
  const offenders = ALL_RULES.filter(
    (r) => r.decision === "prompt" && typeof r.pattern[0] === "string" && RM_BINARIES.has(r.pattern[0]),
  );
  expect(offenders).toEqual([]);
});

test("skip-list carries the rm label with a reason naming the CONFIRM gate", () => {
  const entry = SKIP_LIST.find((s) => s.sourceLabel === RM_LABEL);
  expect(entry).toBeDefined();
  expect(entry?.reason).toContain("CONFIRM");
  expect(entry?.reason).toContain("approval_policy");
});

test("forbidden rm variants (rm -rf of / ~ system dirs) stay present", () => {
  const rmForbidden = CRITICAL_RULES.filter(
    (r) => r.decision === "forbidden" && typeof r.pattern[0] === "string" && RM_BINARIES.has(r.pattern[0]),
  );
  expect(rmForbidden.length).toBeGreaterThan(0);
});

test("unlink and every non-rm prompt rule are unchanged in count", () => {
  const prompts = ALL_RULES.filter((r) => r.decision === "prompt");
  expect(prompts.some((r) => r.pattern[0] === "unlink")).toBe(true);
  // 28 prompt rules before the change, minus bare rm, /bin/rm, /usr/bin/rm.
  expect(prompts.length).toBe(25);
});

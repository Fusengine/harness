import { expect, test } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { REAL_CWD } from "./helpers/real-cwd";

const verdict = (command: string): string => bashWriteGuard({ tool: "Bash", command, cwd: REAL_CWD })?.kind ?? "allow";

// Was pinned to "allow" (the bug: `&>` slipped past the guard while `>` asks). See bash-write-amp-redirect.test.ts.
test("&> is a file write like >", () => {
  expect(verdict("prog &> out.txt")).toBe("ask");
  expect(verdict("echo x &> out.txt")).toBe("block"); // literal text: Write/Edit tool instead
});

test("detects Bash noclobber override >|", () => {
  expect(verdict("prog >| out.txt")).toBe("ask");
  expect(verdict("echo x >| out.txt")).toBe("block"); // literal text: Write/Edit tool instead
  expect(verdict("echo x >| out.ts")).toBe("block");
});

test("process substitution and comparison operators are not file redirects", () => {
  expect(verdict("diff <(printf a) >(printf b)")).toBe("allow");
  expect(verdict("echo $((1 > 0))")).toBe("allow");
  expect(verdict("(( 2 > 1 ))")).toBe("allow");
  expect(verdict('[[ "b" > "a" ]]')).toBe("allow");
});

test("real redirects nested in substitutions inside excluded contexts remain visible", () => {
  expect(verdict('[[ "$(printf x > out.txt)" ]]')).toBe("ask");
  expect(verdict("echo $(( $(printf x > out.ts) + 1 ))")).toBe("block");
});

test("ordinary [[ text and comment markers cannot hide a later redirect", () => {
  expect(verdict("echo [[ x > out.txt ]]" )).toBe("ask");
  expect(verdict("printf x [[ > out.ts")).toBe("block");
  expect(verdict("echo foo[[ > out.ts")).toBe("block");
  expect(verdict("echo ok # [[\necho x > out.ts")).toBe("block");
  expect(verdict("echo ok # ((\necho x > out.ts")).toBe("block");
});

test("nested parentheses cannot close an outer command substitution early", () => {
  expect(verdict('echo "$(echo $((1 > 0)) > out.txt)"')).toBe("ask");
  expect(verdict('echo "$( (printf a); printf x > out.txt)"')).toBe("ask");
  expect(verdict('echo "$(diff <(printf a) >(printf b); echo x > out.ts)"')).toBe("block");
});

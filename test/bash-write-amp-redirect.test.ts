import { expect, test } from "bun:test";
import { join } from "node:path";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { shellFileWriteRedirects, shellOutputRedirects } from "../src/policy/guards/bash-write-redirects";
import { SAFE_WRITE_PATHS } from "../src/policy/guards/bash-write-safe-paths";
import { REAL_CWD } from "./helpers/real-cwd";

const verdict = (command: string): string => bashWriteGuard({ tool: "Bash", command, cwd: REAL_CWD })?.kind ?? "allow";

/** Every command must get the same verdict as its plain `>` twin. */
const FILE_FORMS = [
  "echo x &> {f}", "echo x &>{f}", "echo x&>{f}", "echo x &>> {f}", "echo x &>>{f}", "echo x >& {f}", "echo x >&{f}",
  "echo x >>& {f}", "echo x >|{f}", "echo x >| {f}", "echo x 1>{f}", "echo x 2>{f}", "echo x 2>> {f}", "echo x <>{f}",
  "echo x 1>&{f}", "echo x 2>&{f}", "echo x cmd>|{f}", "true &&>{f}", "true &&>>{f}", "echo x \\&>{f}", "echo x &>'{f}'",
  'echo x &>"{f}"', 'echo x >&"{f}"', "echo x >&\\{f}", "echo x >&|{f}", "echo x >&!{f}", "echo x &> $(printf {f})",
];

test("ampersand and fd-prefixed file redirects ask like a plain `>` on a non-code target", () => {
  // `prog` = command output: it keeps the ask. A fully literal `echo` is refused instead (bash-write-literal-block.test.ts).
  for (const form of FILE_FORMS) expect([form, verdict(form.replace("{f}", "out.txt").replace(/^echo x/, "prog x"))]).toEqual([form, "ask"]);
});

test("ampersand and fd-prefixed file redirects block on a code-file target", () => {
  for (const form of FILE_FORMS.filter((f) => !f.includes("printf"))) {
    expect([form, verdict(form.replace("{f}", "src/x.ts"))]).toEqual([form, "block"]);
  }
  expect(verdict("echo x &> a/B.TS")).toBe("block");
});

test("a file named like a descriptor is still a file for &> (bash writes ./2)", () => {
  expect(verdict("prog x &> 2")).toBe("ask");
  expect(verdict("echo x &> 2")).toBe("block"); // literal text: Write/Edit tool instead
  expect(verdict("echo x &>2")).toBe("block");
  expect(verdict("echo x >&2-")).toBe("ask"); // zsh writes a file named `2-`
});

test("only plain `>&` / `N>&` duplicates; `>>&`, `>&|`, `>&!` always open the named file (zsh)", () => {
  for (const c of ["prog x >>&2", "prog x 2>>&1", "prog x >&|2", "prog x >&!2", "prog x >>&|2", "prog x >&!-", "prog x >>&-", "prog x >|&2"]) {
    expect([c, verdict(c)]).toEqual([c, verdict(c.replace(/>+\|?&[|!]?/, "> "))]);
    expect([c, verdict(c)]).toEqual([c, "ask"]);
  }
  expect(verdict("echo x >>&src/2.ts")).toBe("block");
});

test("`>&$var` stays ask on purpose: the fd is unknowable statically and a non-numeric value writes a file", () => {
  for (const c of ["echo x >&$fd", "echo x >&${fd}", 'echo x >&"$fd"', "echo x 2>&$fd"]) expect([c, verdict(c)]).toEqual([c, "ask"]);
});

test("descriptor duplication and closing are not file writes", () => {
  for (const c of [
    "echo x >&2", "echo x 2>&1", "echo x 1>&2", "echo x >&-", "echo x 2>&-", "cat <&0", "echo x >& 2", "echo x >&'2'", 'echo x >&"2"',
    "echo x 3>&1 1>&2 2>&3", "echo x >&2 && echo y 2>&1", "echo x &>&2", "echo x > &2", "echo x |& cat", "echo x 2>&1 | tee",
  ]) {
    expect([c, verdict(c)]).toEqual([c, "allow"]);
  }
  expect(shellFileWriteRedirects("echo x >&2 2>&1 >&- 2>&- <&0 >& 2")).toEqual([]);
});

test("`2>&1 | tee` keeps its verdict (tee ask), `>&2 echo` and here-strings stay allowed", () => {
  expect(verdict("make 2>&1 | tee build.log")).toBe("ask");
  expect(verdict("make 2>&1 | tee src/a.ts")).toBe("block");
  expect(verdict(">&2 echo oops")).toBe("allow");
  expect(verdict("cat <<< hello")).toBe("allow");
  expect(verdict("grep -q x <<< \"$v\" 2>&1")).toBe("allow");
});

test("writes to /dev/null stay allowed in every ampersand form", () => {
  for (const c of ["ls &>/dev/null", "ls &> /dev/null", "ls >&/dev/null", "ls >& /dev/null", "ls &>>/dev/null", "ls 2>&/dev/null"]) {
    expect([c, verdict(c)]).toEqual([c, "allow"]);
  }
});

test("quoted, escaped and commented operators are not redirects", () => {
  for (const c of ['echo "a &> b"', "echo 'x >& y'", "echo a\\>\\&b", "echo ok # &> out.ts", 'echo "$(echo hi)" "&>x"']) {
    expect([c, verdict(c)]).toEqual([c, "allow"]);
  }
});

test("redirects nested in substitutions are visible for the ampersand forms", () => {
  expect(verdict('echo "$(printf x &> out.txt)"')).toBe("ask");
  expect(verdict("echo `printf x >& out.ts`")).toBe("block");
  expect(verdict("echo $(( $(printf x &> out.ts) + 1 ))")).toBe("block");
});

test("SAFE_WRITE_PATHS behaves exactly as for `>`", () => {
  const safe = join(SAFE_WRITE_PATHS[0] ?? "", "x.log");
  for (const op of [">", "&>", "&>>", ">&", ">>&", "2>>", "1>&"]) {
    expect([op, verdict(`prog x ${op} ${safe}`)]).toEqual([op, verdict(`prog x > ${safe}`)]);
  }
  expect(verdict(`echo x &> ${safe}`)).toBe("allow");
  expect(verdict(`echo x &> ${safe} && prog y &> out.txt`)).toBe("ask");
});

test("the SAFE_PREFIXES short-circuit no longer hides an ampersand redirect", () => {
  expect(verdict("ls &> out.txt")).toBe("ask");
  expect(verdict("git log >& out.ts")).toBe("block");
  expect(verdict("cat a 2>&out.txt")).toBe("ask");
});

test("shellOutputRedirects (other guards) keeps its legacy view; the ampersand forms are extended-only", () => {
  const cmd = "echo a > one.txt; echo b &> two.txt; echo c >& three.txt; echo d >>& four.txt; true &&> five.txt";
  expect(shellOutputRedirects(cmd).map((r) => r.target)).toEqual(["one.txt"]);
  expect(shellFileWriteRedirects(cmd).map((r) => r.target)).toEqual(["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]);
  expect(shellOutputRedirects("echo x &>> f")).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { REAL_CWD } from "./helpers/real-cwd";
import { D, guardVerdict } from "./helpers/redir-corpus";

const SP = D;

/** True when `p` physically resolves to a directory (macOS `/private/tmp` yes, Linux no). */
const resolvesToDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(realpathSync(p)).isDirectory();
  } catch {
    return false;
  }
};
const PRIVATE_TMP = resolvesToDir("/private/tmp");
/** Directory that exists on no host: stands in for `/private/tmp` on Linux to exercise the same fail-closed branch. */
const MISSING_DIR = "/private/fh-bwlit-no-such-dir";
const HEREDOC = (head: string, body: string, tail = "EOF"): string => `${head}\n${body}\n${tail}`;

/** Literal non-code writes: ask -> block with a Write/Edit message. */
const BLOCK_LITERAL: ReadonlyArray<readonly [string]> = [
  [`cd ${REAL_CWD} && printf '%s\\n' '- [a](b.md) — c' >> MEMORY.md && tail -2 MEMORY.md`],
  ["echo x > notes.md"],
  ["printf 'a\\n' >> a.txt"],
  [HEREDOC("cat > a.md <<EOF", "hi")],
  [HEREDOC("cat <<'E' > a.md", "x", "E")],
  [HEREDOC("cat <<'E' > a.md", "$HOME literal", "E")],
  ["tee a.txt <<< hi"],
  ["echo hi >| a.md"],
  ["echo hi &> a.md"],
  ["echo 'a b' > notes.md 2>&1"],
  // Literal text is not command output, even into system temp.
  ["echo x > /tmp/fh-bwlit-lit.txt"],
];

/** Literal echo with an fd-prefixed redirect into temp is still literal text: the temp window must not take it. */
const ASK_TEMP_ECHO: ReadonlyArray<readonly [string]> = [["echo x 1> /tmp/fh-bwlit-fd.txt"], ["echo x >& /tmp/fh-bwlit-fd.txt"]];

/** Command output strictly inside scratchpad / system temp (narrow producers), plus non-writes: allow. */
const ALLOW: ReadonlyArray<readonly [string]> = [
  [`git diff > ${SP}/x.patch`],
  [`git log --oneline > ${SP}/out.log 2>&1`],
  [`bun test > ${SP}/out.log 2>&1`],
  ["git diff > /tmp/fh-bwlit-x.patch"],
  ["git show HEAD > /tmp/fh-bwlit-y.patch"],
  ["echo hi"],
  ["cmd > /dev/null"],
  ["cmd 2>&1"],
  ["ls"],
  ["git status"],
  ["tee /dev/stderr <<< hi"], // allow on main too: unchanged
];

/** Anything else that was ask stays ask. */
const ASK: ReadonlyArray<readonly [string]> = [
  ["git diff > ./x.patch"],
  ["cmd > out.log"],
  [`unknownprog > ${SP}/out.log`],
  [`git diff --output=./z.patch > ${SP}/out.log`],
  [`git push > ${SP}/out.log`],
  ['echo "$X" > notes.md'],
  ["echo $(date) > notes.md"],
  ["echo `date` > notes.md"],
  ["prog | tee notes.txt"],
  ["echo x > $SP/../escape"],
  ["git diff > /tmp/sub/x.patch"],
  ["git diff > /tmp/../etc/x.patch"],
  ["git diff > /tmp/x.patch && git diff > out.log"],
  ["git diff > /tmp/fh-bwlit-z.patch; git diff > out.log"],
  ["cat > notes.md"],
  ["git add . && echo x > notes.md"],
  ["echo x > notes.md & echo y"],
  ["echo x | tee notes.md"],
  ["echo x > a.md > b.md"],
  // Challenger: devices are not files the Write tool can create, and these printf forms are not fixed text.
  ["echo error > /dev/stderr"],
  ["echo error >> /dev/stderr"],
  ["printf 'x\\n' > /dev/stdout"],
  ["echo hi > /dev/tty"],
  ["echo hi > /dev/fd/2"],
  ["echo hi > /dev/tcp/127.0.0.1/80"],
  [HEREDOC("cat > /dev/stderr <<EOF", "msg")],
  ["printf '%(%s)T\\n' -1 > notes.txt"],
  ["printf -v X a > notes.txt"],
  // Challenger round 2: other spellings of the same devices / paths that cannot be resolved statically.
  ["cd /dev && echo a > stderr"],
  ["cd /dev; echo a > tty"],
  ["cd /dev/fd && echo a > 2"],
  ["echo a > //dev/stderr"],
  ["echo a > /./dev/stderr"],
  ["echo a > /private/var/run/../../dev/stderr"],
  [HEREDOC("cat > //dev/stderr <<EOF", "msg")],
  ["tee f.txt //dev/stderr <<< hi"],
  ["cd sub && echo a > notes.md"],
  ["echo a > ../notes.md"],
];

/** Unchanged blocks. */
const BLOCK_CODE: ReadonlyArray<readonly [string]> = [
  ["echo x > src/a.ts"],
  [HEREDOC("cat > a.ts <<EOF", "x")],
  ["tee a.ts <<< hi"],
  // Already a block on main (unquoted heredoc with an expansion body): must stay a block.
  [HEREDOC("cat <<EOF > a.md", "$HOME")],
];

describe("bash write: literal text -> block, command output in scratchpad/temp -> allow", () => {
  test.each(BLOCK_LITERAL)("block literal: %s", (cmd) => {
    expect(guardVerdict(cmd, SP, REAL_CWD)).toBe("block");
  });
  test.each(ASK_TEMP_ECHO)("not command output (stays ask): %s", (cmd) => {
    expect(guardVerdict(cmd, SP, REAL_CWD)).toBe("ask");
  });
  test.each(ALLOW)("allow: %s", (cmd) => {
    expect(guardVerdict(cmd, SP, REAL_CWD)).toBe("allow");
  });
  test.each(ASK)("ask: %s", (cmd) => {
    expect(guardVerdict(cmd, SP, REAL_CWD)).toBe("ask");
  });
  test.each(BLOCK_CODE)("block code file: %s", (cmd) => {
    expect(guardVerdict(cmd, SP, REAL_CWD)).toBe("block");
  });
  // `/private/tmp` is macOS-only: where it resolves, literal text blocks and command output is allowed;
  // where it cannot be resolved (Linux) the guard fails closed to ask, never allow.
  test("/private/tmp: literal text -> block where it resolves, ask (never allow) elsewhere", () => {
    expect(guardVerdict("printf 'a' > /private/tmp/fh-bwlit-lit.txt", SP, REAL_CWD)).toBe(PRIVATE_TMP ? "block" : "ask");
  });
  test("/private/tmp: command output -> allow where it resolves, ask (never allow) elsewhere", () => {
    expect(guardVerdict("git diff > /private/tmp/fh-bwlit-x.patch", SP, REAL_CWD)).toBe(PRIVATE_TMP ? "allow" : "ask");
  });
  test("unresolvable temp parent fails closed to ask (the Linux branch of the /private/tmp rows)", () => {
    expect(resolvesToDir(MISSING_DIR)).toBe(false);
    expect(guardVerdict(`printf 'a' > ${MISSING_DIR}/x.txt`, SP, REAL_CWD)).toBe("ask");
    expect(guardVerdict(`git diff > ${MISSING_DIR}/x.patch`, SP, REAL_CWD)).toBe("ask");
  });
  test("system temp allow does not need a scratchpad dir", () => {
    expect(guardVerdict("git diff > out.log")).toBe("ask");
    expect(guardVerdict("git diff > /tmp/fh-bwlit-y.patch")).toBe("allow");
  });
  test("message names the target and the tool", () => {
    const over = bashWriteGuard({ tool: "Bash", command: "echo x > notes.md", cwd: REAL_CWD });
    expect(over?.kind).toBe("block");
    expect(over?.reason).toContain("Bash file write of literal text");
    expect(over?.reason).toContain("Write tool");
    expect(over?.reason).toContain("notes.md");
    const append = bashWriteGuard({ tool: "Bash", command: "printf 'a\\n' >> a.txt", cwd: REAL_CWD });
    expect(append?.reason).toContain("Edit tool");
    expect(append?.reason).toContain("a.txt");
  });
});

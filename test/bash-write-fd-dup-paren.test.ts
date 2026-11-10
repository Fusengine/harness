import { describe, expect, test } from "bun:test";
import { D, P, expand, guardVerdict as verdict } from "./helpers/redir-corpus";

/** Regression: a descriptor dup/close or `/dev/null` target glued to a closing paren (`(cmd 2>&1)`) was read as the file `1)`. */

/** Writes no file: must pass silently (verdict allow). */
const SILENT: readonly string[] = [
  "cd /Users/x/guac; (ruby -ryaml -e 'd=YAML.safe_load(File.read(\"docker-compose.yml\")); p d[\"services\"].keys, d[\"services\"][\"guacamole\"][\"environment\"][\"REMOTE_IP_VALVE_ENABLED\"]' 2>&1) || true; which bun yq",
  "(echo x 2>&1)",
  "(echo x 2>&1) || true",
  "{ echo x 2>&1; }",
  "x=$(echo y 2>&1)",
  "echo x 2>&1;",
  "echo x 2>&1|cat",
  "echo x 2>&1&&true",
  "(echo x >&2)",
  "(echo x 1>&2)",
  "(cat <&0)",
  "(echo x 2>&-)",
  "echo x >/dev/null",
  "echo x 2>/dev/null",
  "echo x &>/dev/null",
  "(echo x >/dev/null)",
  "(echo x &>/dev/null)",
  "echo 'a > b'",
  "ruby -e 'p 1 > 0'",
  "(echo x >&2) && (echo y 2>&1)",
  "((echo x 2>&1))",
  "(echo x >&-)",
  "(echo x >&\"2\")",
  "(echo x >>/dev/null)",
  "(echo x 2>/dev/null)",
  "f() (echo x >&2)",
  "cat <(echo x 2>&1)",
  "diff <(ls 2>&1) <(ls 2>/dev/null)",
  "(echo x 2>&1) | cat",
  "(echo x >&2)2>&1",
  "echo x >&2)",
  "(echo x > /dev/null)",
  "(echo x >/dev/null 2>&1)",
  "(echo x 2>&1 >/dev/null)",
];

/** Verdict frozen from main (0282275, 0.1.115): every row must keep it. `[command, verdict]`. */
const FROZEN: readonly (readonly [string, "allow" | "ask" | "block"])[] = [
  ["cat <<'E'\na > b\nE", "block"],
  ["echo x > f", "ask"],
  ["echo x >> f", "ask"],
  ["echo x 2> f", "ask"],
  ["echo x &> f", "ask"],
  ["echo x >| f", "ask"],
  ["echo x | tee f", "ask"],
  ["echo x > src/a.ts", "block"],
  ["(echo x > f)", "ask"],
  ["(echo x 2>&1 > f)", "ask"],
  ["echo x 2>&1 > f", "ask"],
  ["echo x >&2; echo x > f", "ask"],
  ["echo x 2>& 1file", "ask"],
  ["echo x >&f", "ask"],
  ["(echo x >&f)", "ask"],
  ["echo x > \"&1\"", "ask"],
  ["echo x >&1f", "ask"],
  ["(echo x >&f.ts)", "block"],
  ["fd=f; echo x >&$fd", "ask"],
  ["(echo x >&1f)", "ask"],
  ["(echo x 2>&1f)", "ask"],
  ["(echo x >&1.ts)", "block"],
  ["(echo x >&\"1)\")", "ask"],
  ["(echo x >&1a)", "ask"],
  ["(echo x >&2-)", "ask"],
  ["(echo x >>&2)", "ask"],
  ["(echo x >&|2)", "ask"],
  ["(echo x &>f)", "ask"],
  ["(echo x &> f.ts)", "block"],
  ["(echo x >&1 > f)", "ask"],
  ["(echo x > f.ts)", "block"],
  ["(echo x >&2) > f", "ask"],
  ["(echo x >&2); echo y > f", "ask"],
  ["(echo x 2>&1); echo y > src/a.ts", "block"],
  ["(echo x >f)", "ask"],
  ["(echo x >>f)", "ask"],
  ["(echo x >|f)", "ask"],
  ["(echo x >f.ts)", "block"],
  ["(echo x 2>&1)>f", "ask"],
  ["echo ')' > f", "ask"],
  ["echo \")\" > f", "ask"],
  ["echo x > f)", "ask"],
  ["(echo x > a\\)b)", "ask"],
  ["echo x > >(cat)", "allow"],
  ["tee >(cat) </dev/null", "ask"],
  ["diff <(ls) <(ls)", "allow"],
  ["cmd 2> >(cat)", "allow"],
  ["case x in a) echo y > f;; esac", "ask"],
  ["(echo x > ~/.claude/logs); echo y | tee .env", "ask"],
  ["(echo x > ~/.claude/logs)", "ask"],
  ["(echo x > ~/.fuse-harness/cache)", "ask"],
  ["(echo x > $HOME/.claude/logs)", "ask"],
  ["(echo x > ~/.claude/logs); dd if=/etc/hosts of=notes.txt", "ask"],
  ["echo x >)", "ask"],
  ["echo x > )", "ask"],
  ["(echo x >)", "ask"],
  ["(echo x >&)", "ask"],
  ["(echo x >>f)", "ask"],
  ["(echo x > ~/.claude/logs/a)", "allow"],
];

/** The only real write is to an allowed safe path (or none): the dup no longer adds a bogus file, so the verdict equals the paren-free twin. */
const TWINS: readonly (readonly [string, string])[] = [
  ["(echo x > ~/.claude/logs/a 2>&1)", "echo x > ~/.claude/logs/a 2>&1"],
  ["(echo x 2>&1) > ~/.claude/logs/a", "echo x 2>&1 > ~/.claude/logs/a"],
  ["(echo x 2>&1) && touch notes.txt", "echo x 2>&1 && touch notes.txt"],
];

describe("fd dup/close and /dev/null glued to a closing paren write no file", () => {
  test("silent rows", () => {
    for (const cmd of SILENT) expect([cmd, verdict(cmd)]).toEqual([cmd, "allow"]);
  });
  test("every real file write keeps main's verdict", () => {
    for (const [cmd, v] of FROZEN) expect([cmd, verdict(cmd)]).toEqual([cmd, v]);
  });
  test("a glued dup next to a real write gives the paren-free twin's verdict", () => {
    for (const [paren, twin] of TWINS) expect([paren, verdict(paren)]).toEqual([paren, verdict(twin)]);
  });
  test("scratchpad window unchanged: inside allow, outside and subshell forms ask", () => {
    const rows: readonly (readonly [string, "allow" | "ask"])[] = [
      ["echo x > @D/a.txt", "allow"], ["echo x &> @D/a.txt", "allow"], ["echo x 2>&1 > @D/a.txt", "allow"], ["echo x > @D/a.txt 2>&1", "allow"],
      ["echo x > @P/a.txt", "ask"], ["echo x &> @P/a.txt", "ask"], ["(echo x > @D/a.txt)", "ask"], ["(echo x > @D/a.txt 2>&1)", "ask"],
      ["(echo x >&2) > @D/a.txt", "ask"], ["echo x > @D/../a.txt", "ask"], ["(echo x > @P/a.txt)", "ask"],
    ];
    for (const [cmd, v] of rows) expect([cmd, verdict(expand(cmd), D)]).toEqual([cmd, v]);
    expect(P).toBe("/Users/me/proj");
  });
});

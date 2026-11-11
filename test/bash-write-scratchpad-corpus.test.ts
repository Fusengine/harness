import { describe, expect, test } from "bun:test";
import { bashWriteGuard } from "../src/policy/guards/bash-write";
import { ROWS_A } from "./helpers/redir-corpus-a";
import { ROWS_B } from "./helpers/redir-corpus-b";
import { ROWS_C } from "./helpers/redir-corpus-c";
import { D, askNow, expand, nowOf } from "./helpers/redir-corpus";

const ROWS = [...ROWS_A, ...ROWS_B, ...ROWS_C];

function verdict(cmd: string, scratchpadDir: string | undefined): "allow" | "ask" | "block" {
  const r = bashWriteGuard({ tool: "Bash", command: expand(cmd), scratchpadDir });
  return r === null ? "allow" : r.kind === "ask" ? "ask" : "block";
}

describe("redirect-narrowing corpus (frozen old verdicts from main)", () => {
  test("corpus is non-trivial and every safe row was an ask before", () => {
    expect(ROWS.length).toBeGreaterThan(150);
    for (const row of ROWS.filter((r) => r.safe)) expect(row.old, row.id).toBe("ask");
  });

  test("without scratchpad_dir every row keeps its old verdict", () => {
    for (const row of ROWS) expect(verdict(row.cmd, undefined), row.id).toBe(nowOf(expand(row.cmd), row.old));
  });

  test("with scratchpad_dir: safe rows become allow, every other row keeps its old verdict", () => {
    for (const row of ROWS) expect(verdict(row.cmd, D), row.id).toBe(row.safe ? "allow" : nowOf(expand(row.cmd), row.old));
  });

  test("no block is ever relaxed and no ask outside the safe rows becomes allow", () => {
    for (const row of ROWS) {
      const now = verdict(row.cmd, D);
      if (row.old === "block") expect(now, row.id).toBe("block");
      if (row.old === "ask" && !row.safe) expect(now, row.id).toBe(askNow(expand(row.cmd)));
    }
  });
});

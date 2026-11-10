import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPrdCompact } from "../../src/cli/prd/compact";
import { runPrdStatus } from "../../src/cli/prd/status";
import { runPrdValidate } from "../../src/cli/prd/validate";
import { classifyRouterText, describeRouterState, routerProblems } from "../../src/policy/prd/prd-router-state";
import { readRouter, readRouterState, readRouterSync } from "../../src/policy/prd/prd-io";
import { buildFixture, capture, tmpRoot } from "../cli/prd-fixtures";
import { SCHEMA_BAD, SYNTAX_BAD, VALID } from "./helpers";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** Fresh `.claude` project; the router holds `router` (null = no router file). */
function project(router: string | null): string {
  const root = tmpRoot();
  roots.push(root);
  buildFixture(root);
  const path = join(root, ".claude", "apex", "prd.json");
  if (router === null) rmSync(path);
  else writeFileSync(path, router);
  return root;
}

describe("classifyRouterText / routerProblems", () => {
  test("ok / syntax / schema are distinguished, with parse error and field+reason", () => {
    expect(classifyRouterText(VALID).state).toBe("ok");
    const syntax = classifyRouterText(SYNTAX_BAD);
    expect(syntax.state).toBe("syntax");
    const schema = classifyRouterText(SCHEMA_BAD);
    expect(schema).toMatchObject({ state: "schema" });
    expect(routerProblems(JSON.parse(SCHEMA_BAD))[0]).toContain("auth-refactor.status");
    expect(routerProblems(JSON.parse(SCHEMA_BAD))[0]).toContain("in_progress");
  });

  test("non-object roots and bad fields are schema problems, never throws", () => {
    for (const text of ["null", "[]", "3", '{"t":1}', '{"t":{"prd":1,"status":"assigned"}}', '{"t":{"prd":"p","status":"assigned","validated-at":2}}']) {
      expect(classifyRouterText(text).state).toBe("schema");
      expect(describeRouterState(classifyRouterText(text), "/x/prd.json")).toContain("schema invalid");
    }
    expect(classifyRouterText("").state).toBe("syntax");
  });
});

describe("readRouterState + back-compat wrappers", () => {
  test("absent / syntax / schema / ok on disk; readRouter and readRouterSync keep returning null for every non-ok state", async () => {
    const cases: Array<[string | null, "absent" | "syntax" | "schema" | "ok"]> = [[null, "absent"], [SYNTAX_BAD, "syntax"], [SCHEMA_BAD, "schema"], [VALID, "ok"]];
    for (const [text, state] of cases) {
      const root = project(text);
      expect((await readRouterState(root, ".claude")).state).toBe(state);
      const legacy = await readRouter(root, ".claude");
      expect(legacy === null).toBe(state !== "ok");
      expect(readRouterSync(root, ".claude") === null).toBe(state !== "ok");
    }
  });

  test("an unreadable router (a directory) is reported as a read error, not as absent", async () => {
    const root = project(null);
    mkdirSync(join(root, ".claude", "apex", "prd.json"));
    const state = await readRouterState(root, ".claude");
    expect(state.state).toBe("syntax");
    expect(describeRouterState(state, "p")).toContain("cannot read");
  });
});

describe("CLI diagnostics (case 5): distinct messages, exit codes unchanged", () => {
  test("status: absent / syntax / schema -> distinct stderr, exit 1", async () => {
    const out: Record<string, string> = {};
    for (const [name, text] of [["absent", null], ["syntax", SYNTAX_BAD], ["schema", SCHEMA_BAD]] as const) {
      const root = project(text);
      const r = await capture(() => runPrdStatus(["--root", root, "--id", "claude-code"], root, {}));
      expect(r.code).toBe(1);
      out[name] = r.stderr;
    }
    expect(out.absent).toContain("no PRD router at");
    expect(out.syntax).toContain("malformed JSON");
    expect(out.syntax).toContain("syntax error");
    expect(out.syntax).not.toContain("no PRD router at");
    expect(out.schema).toContain("schema invalid");
    expect(out.schema).not.toContain("malformed JSON");
    expect(out.schema).toContain("in_progress");
  });

  test("validate and compact: broken router no longer says 'no such task', exit 2 unchanged", async () => {
    for (const text of [SYNTAX_BAD, SCHEMA_BAD, null]) {
      const root = project(text);
      const env = { FUSE_PRD: "1" };
      const v = await capture(() => runPrdValidate(["auth-refactor", "--root", root, "--id", "claude-code"], root, env));
      const c = await capture(() => runPrdCompact(["auth-refactor", "--root", root, "--id", "claude-code"], root, env));
      for (const r of [v, c]) {
        expect(r.code).toBe(2);
        expect(r.stderr).not.toContain("no such task");
        expect(r.stderr).toContain(text === null ? "no PRD router at" : text === SYNTAX_BAD ? "malformed JSON" : "schema invalid");
      }
    }
  });

  test("valid router: status / validate lookups behave exactly as before", async () => {
    const root = project(VALID);
    const s = await capture(() => runPrdStatus(["--root", root], root, {}));
    expect(s.code).toBe(0);
    const v = await capture(() => runPrdValidate(["nope", "--root", root], root, { FUSE_PRD: "1" }));
    expect(v.code).toBe(2);
    expect(v.stderr).toContain('no such task "nope"');
  });
});

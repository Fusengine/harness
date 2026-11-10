import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import type { PrdTestEnv } from "../runtime/prd/env";
import { SCHEMA_BAD, VALID, allowed, denyReason, gate, isDenied, patchEvent, withRouter } from "./helpers";

const REL = (env: PrdTestEnv): string => `${env.homeSeg}/apex/prd.json`;
const wrap = (...blocks: string[]): string => `*** Begin Patch\n${blocks.join("\n")}\n*** End Patch`;
const add = (path: string, text: string): string => `*** Add File: ${path}\n+${text}`;
const upd = (path: string, from: string, to: string): string => `*** Update File: ${path}\n@@\n-${from}\n+${to}`;

describe("recovery: exactly ONE file operation on the router (challenger cx11/cx12/cx13)", () => {
  test("cx11: Add valid, then Add of the SAME file by absolute path with garbage -> denied", () =>
    withRouter(".codex", SCHEMA_BAD, async (env, router) => {
      const out = await gate("codex", env, patchEvent(env, wrap(add(REL(env), VALID), add(router, "garbage"))));
      expect(isDenied(out!.stdout)).toBe(true);
    }));

  test("cx13: Update that fixes it, then Add ./spelling with garbage -> denied", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      const out = await gate("codex", env, patchEvent(env, wrap(upd(REL(env), SCHEMA_BAD, VALID), add(`./${REL(env)}`, "garbage"))));
      expect(isDenied(out!.stdout)).toBe(true);
    }));

  test("cx12: Update that fixes it, then Delete by absolute path -> denied", () =>
    withRouter(".codex", SCHEMA_BAD, async (env, router) => {
      const out = await gate("codex", env, patchEvent(env, wrap(upd(REL(env), SCHEMA_BAD, VALID), `*** Delete File: ${router}`)));
      expect(isDenied(out!.stdout)).toBe(true);
    }));

  test("a symlinked parent spelling of the router still counts as the router (two operations -> denied)", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      symlinkSync(join(env.root, env.homeSeg), join(env.root, "alias"));
      const out = await gate("codex", env, patchEvent(env, wrap(add(REL(env), VALID), add(join(env.root, "alias", "apex", "prd.json"), "garbage"))));
      expect(isDenied(out!.stdout)).toBe(true);
    }));

  test("a single Add of the full valid router is allowed", () =>
    withRouter(".codex", SCHEMA_BAD, async (env) => {
      expect(allowed(await gate("codex", env, patchEvent(env, wrap(add(REL(env), VALID)))))).toBe(true);
    }));
});

describe("recovery: @@ context cannot be resolved with certainty (challenger cx28b)", () => {
  const MULTI = '{\n  "t": {\n    "prd": "q",\n    "status": "in_progress"\n  }\n}';
  const hunk = (env: PrdTestEnv, header: string): string =>
    wrap(`*** Update File: ${REL(env)}\n${header}\n-    "status": "in_progress"\n+    "status": "in-progress"`);

  test("an Update with an '@@ <context>' header is denied with a clear reason", () =>
    withRouter(".codex", MULTI, async (env) => {
      const out = await gate("codex", env, patchEvent(env, hunk(env, '@@ "prd": "q",')));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("cannot determine");
    }));

  test("the same Update with a bare '@@' is allowed", () =>
    withRouter(".codex", MULTI, async (env) => {
      expect(allowed(await gate("codex", env, patchEvent(env, hunk(env, "@@"))))).toBe(true);
    }));
});

describe("prevention sees every operation on the router, any spelling", () => {
  test("valid router: Update then a later Add of garbage by absolute path -> denied", () =>
    withRouter(".codex", VALID, async (env, router) => {
      const out = await gate("codex", env, patchEvent(env, wrap(upd(REL(env), "in-progress", "validated"), add(router, "garbage"))));
      expect(isDenied(out!.stdout)).toBe(true);
    }));

  test("valid router: a later Delete by absolute path -> denied (PRD would switch off)", () =>
    withRouter(".codex", VALID, async (env, router) => {
      const out = await gate("codex", env, patchEvent(env, wrap(upd(REL(env), "in-progress", "validated"), `*** Delete File: ${router}`)));
      expect(isDenied(out!.stdout)).toBe(true);
      expect(denyReason(out!.stdout)).toContain("delete");
    }));

  test("valid router: a lone Delete -> denied", () =>
    withRouter(".codex", VALID, async (env) => {
      expect(isDenied((await gate("codex", env, patchEvent(env, wrap(`*** Delete File: ${REL(env)}`))))!.stdout)).toBe(true);
    }));

  test("valid router: '@@ <context>' Update is not judged (underivable) -> unchanged allow", () =>
    withRouter(".codex", VALID, async (env) => {
      const p = wrap(`*** Update File: ${REL(env)}\n@@ "x"\n-${VALID}\n+${VALID}`);
      expect(allowed(await gate("codex", env, patchEvent(env, p)))).toBe(true);
    }));
});

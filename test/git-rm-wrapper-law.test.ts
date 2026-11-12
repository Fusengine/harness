/**
 * Monotone law for git / rm / gh verdicts: a wrapper that still executes the
 * atom must never produce a weaker verdict than the bare atom, nor than the
 * minimum the owner's rules require (`spec`). Generator: atoms x wrappers
 * (+ git global options, + depth-2 nesting). Prints generated / bypass counts.
 */
import { test, expect } from "bun:test";
import { GH_ATOMS, GIT_ATOMS, GIT_OPTS, RM_ATOMS, WRAPPERS, rank, wrap, type Atom } from "./helpers/wrapper-law";

interface Gen { cmd: string; bare: string; spec: number; fam: string }
interface Row { cmd: string; need: number; got: number; fam: string }

const gitForms = (a: Atom): string[] => [a.cmd.replace("{G}", ""), ...GIT_OPTS.map((o) => a.cmd.replace("{G}", o))];
const FAMILIES: [string, Atom[]][] = [["git", GIT_ATOMS], ["rm", RM_ATOMS], ["gh", GH_ATOMS]];

/** All generated rows: git options and wrappers at depth 1, selected wrappers at depth 2. */
function generate(): Gen[] {
  const out: Gen[] = [];
  for (const [fam, atoms] of FAMILIES) {
    for (const a of atoms) {
      const bare = a.cmd.replace("{G}", "");
      for (const form of a.cmd.includes("{G}") ? gitForms(a) : [bare]) {
        if (form !== bare) out.push({ cmd: form, bare, spec: a.spec, fam });
        for (const w of WRAPPERS) {
          out.push({ cmd: wrap(w, form), bare, spec: a.spec, fam });
          // `FOO=1 ( … )` / `FOO=1 { …; }` are shell syntax errors, not execution-preserving: skip them.
          const compound = /^(?:\(|\{|if |for |while |f\(\))/.test(w);
          for (const w2 of ["sh -c '{C}'", "cd x && {C}", "( {C} )", ...(compound ? [] : ["FOO=1 {C}"])]) out.push({ cmd: wrap(w2, wrap(w, form)), bare, spec: a.spec, fam });
        }
      }
    }
  }
  return out;
}

const all = generate();
const law: Row[] = [];
const spec: Row[] = [];
for (const r of all) {
  const got = rank(r.cmd);
  const bare = rank(r.bare);
  if (got < bare) law.push({ cmd: r.cmd, need: bare, got, fam: r.fam });
  if (got < r.spec) spec.push({ cmd: r.cmd, need: r.spec, got, fam: r.fam });
}
const sample = (rs: Row[]): string => rs.slice(0, 15).map((r) => `${JSON.stringify(r.cmd)} need>=${r.need} got=${r.got}`).join("\n");
const byFam = (rs: Row[]): string => FAMILIES.map(([f]) => `${f}=${rs.filter((r) => r.fam === f).length}`).join(" ");

test("generated wrapper set size", () => {
  console.log(`[wrapper-law] generated=${all.length} law-bypass(wrapped<bare)=${law.length} (${byFam(law)}) spec-bypass(wrapped<required)=${spec.length} (${byFam(spec)})`);
  expect(all.length).toBeGreaterThan(1000);
});

test("law: no wrapped git/rm/gh verdict is weaker than its bare form", () => {
  if (law.length > 0) console.log(sample(law));
  expect(law.length).toBe(0);
});

test("spec: every bare and wrapped form meets the owner's minimum verdict", () => {
  if (spec.length > 0) console.log(sample(spec));
  expect(spec.length).toBe(0);
});

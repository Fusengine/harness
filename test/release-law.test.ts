/**
 * Law: `releaseAction` is at least as strong as the merge-base classifier
 * (`baseReleaseAction`, kept verbatim) on every generated command, and no slower than
 * a small constant factor on nested substitutions.
 */
import { describe, test, expect } from "bun:test";
import { releaseAction } from "../src/policy/release-command";
import { baseReleaseAction } from "../src/policy/release-command-base";

const flood = (n: number, sep = " "): string => Array.from({ length: n }, () => "$(true)").join(sep);
const STEPS = [
  "gh pr merge 1", "gh pr -R o/r merge 1", "gh pr \"merge\" 1", "g''h pr merge 1", "git tag v1", "git -c 'x.y=a;b' tag v1", "git -C 'a|b' tag v1", "git tag -- v1", "git tag --no-sign v1",
  "git tag --create-reflog v1", "git tag --cleanup=strip v1", "git tag -c x v1", "git -C x tag -a v1 -m m", "git ta''g v1", "git tag -l", "git tag", "gh pr view 1", "git commit -m x",
];
const SEPARATORS = ["; ", " && ", " | ", " || ", "\n"];
const PLACE: ((s: string) => string)[] = [
  (s) => s, (s) => `$(${s})`, (s) => `\`${s}\``, (s) => `<(${s})`, (s) => `sh -c '${s.replaceAll("'", "'\\''")}'`, (s) => `bash -c "${s.replaceAll('"', '\\"')}"`, (s) => `( ${s} )`, (s) => `eval '${s.replaceAll("'", "'\\''")}'`,
];

describe("releaseAction is never weaker than the merge-base classifier", () => {
  test.each([398, 399, 401, 1000, 5000])("flood of %i substitutions x steps x separators x placements", (k) => {
    const weaker: string[] = [];
    let checked = 0;
    // The merge-base classifier is quadratic in the flood, so the large floods use a thinner (still varied) matrix.
    const big = k >= 1000;
    const steps = big ? STEPS.filter((_, i) => i % 3 === 0) : STEPS;
    const seps = big ? SEPARATORS.slice(0, 2) : SEPARATORS;
    const places = big ? PLACE.slice(0, 5) : PLACE;
    for (const step of steps) for (const sep of seps) for (const place of places) {
      for (const cmd of [`echo ${flood(k)}${sep}${place(step)}`, `echo ${flood(k)} ${place(step)}`, `${place(step)}${sep}echo ${flood(k)}`]) {
        checked++;
        if (baseReleaseAction(cmd) !== null && releaseAction(cmd) === null) weaker.push(cmd.slice(-120));
      }
    }
    expect(checked).toBeGreaterThan(big ? 100 : 1000);
    expect(weaker).toEqual([]);
  }, 120000);
  test("depth: nested $( ) and sh -c wrappers around every step", () => {
    const weaker: string[] = [];
    for (const step of STEPS) {
      let cmd = step;
      for (let depth = 0; depth < 12; depth++) {
        cmd = depth % 2 === 0 ? `$(${cmd})` : `sh -c '${cmd.replaceAll("'", "'\\''")}'`;
        const text = `echo ${flood(401)}; echo ${cmd}`;
        if (baseReleaseAction(text) !== null && releaseAction(text) === null) weaker.push(text.slice(-100));
      }
    }
    expect(weaker).toEqual([]);
  });
  test("reads and non-release steps stay null behind the flood", () => {
    for (const step of ["git tag -l", "git tag", "gh pr view 1", "git commit -m x"]) expect(releaseAction(`echo ${flood(1000)}; ${step}`)).toBeNull();
  });
});

describe("latency on nested substitutions", () => {
  const nested = (k: number): string => `echo ${"$(".repeat(k)}gh pr merge 1${")".repeat(k)}`;
  const best = (fn: () => unknown): number => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      fn();
      times.push(performance.now() - t);
    }
    return Math.min(...times);
  };
  /** Candidate time at most 5x the base AND at most 1 s (minimum of 5 samples each): the walk runs once before the base. */
  const withinBudget = (cmd: string): { ok: boolean; mine: number; base: number } => {
    const mine = best(() => releaseAction(cmd));
    const base = best(() => baseReleaseAction(cmd));
    return { ok: mine <= 5 * base && mine <= 1000, mine, base };
  };
  // The challenger's big families (384-544 KB).
  test.each([
    ["true; x64000", "true; ".repeat(64000)],
    ["echo 'a b' | sh; x32000", "echo 'a b' | sh; ".repeat(32000)],
    ["bash heredoc x64000", `bash <<EOF\n${"echo a\n".repeat(64000)}EOF`],
    ["braces x96000", `{ ${"x; ".repeat(96000)}${"}".repeat(96000)}`],
    ["one 500 KB echo | sh", `echo '${"a ".repeat(250000)}' | sh`],
  ] as const)("big family %s", (_name, cmd) => {
    expect(withinBudget(cmd).ok).toBe(true);
    expect(releaseAction(cmd)).toBe(baseReleaseAction(cmd));
  }, 120000);
  test.each([2000, 5000])("nested $( ) with a release step, k=%i", (k) => {
    const cmd = nested(k);
    expect(withinBudget(cmd).ok).toBe(true);
    expect(releaseAction(cmd)).toBe(baseReleaseAction(cmd));
  }, 120000);
  // With a git word the walk really runs: it costs tens of ns/char, so only the absolute bound holds there.
  test.each([["100 KB", 50000], ["500 KB", 250000]] as const)("git word inside a big quoted string, %s: under 1 s, same result", (_n, k) => {
    const cmd = `echo 'git ${"a ".repeat(k)}' | sh`;
    expect(best(() => releaseAction(cmd))).toBeLessThan(1000);
    expect(releaseAction(cmd)).toBe(baseReleaseAction(cmd));
  });
  // Nested eval of ever longer arguments (the challenger's corpus): the walk's budgets hand over to the base.
  const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  const evalNest = (k: number, comment: boolean): string => {
    let p = `echo ${"a ".repeat(k)}`;
    for (let i = 0; i < 9; i++) p = `eval ${quote(p)} y`;
    return comment ? `${p} # c'` : p;
  };
  test.each([[20000, false], [20000, true], [200000, false], [200000, true]] as const)("nested eval, K=%i, comment=%s", (k, comment) => {
    const cmd = evalNest(k, comment);
    const r = withinBudget(cmd);
    expect(r.ok).toBe(true);
    expect(releaseAction(cmd)).toBe(baseReleaseAction(cmd));
  }, 120000);
});

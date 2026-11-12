/**
 * Fail closed at the analysis budget: a release step behind a flood of substitutions
 * (401 / 1000 / 5000 `$(…)`) must still be classified, as the base did.
 */
import { describe, test, expect } from "bun:test";
import { releaseAction } from "../src/policy/release-command";

const flood = (n: number): string => Array.from({ length: n }, () => "$(true)").join(" ");

describe("release step behind a substitution flood", () => {
  test.each([401, 1000, 5000])("%i substitutions before the step", (n) => {
    expect(releaseAction(`echo ${flood(n)}; gh pr merge 1`)).toBe("merge");
    expect(releaseAction(`echo ${flood(n)}; git tag v1`)).toBe("tag");
    expect(releaseAction(`echo ${flood(n)} && gh -R o/r pr merge 1 --merge`)).toBe("merge");
    expect(releaseAction(`echo ${flood(n)}; git -C x tag -a v1 -m m`)).toBe("tag");
    // the step inside a substitution that comes AFTER the budget is spent
    expect(releaseAction(`echo ${flood(n)} $(gh pr merge 1)`)).toBe("merge");
    expect(releaseAction(`echo ${flood(n)} $(git tag v1)`)).toBe("tag");
    expect(releaseAction(`echo ${flood(n)} \`gh pr merge 1\``)).toBe("merge");
  });
  test.each([399, 401, 1200])("quoted / obfuscated step behind %i substitutions", (n) => {
    for (const s of ['gh pr "merge" 1', "g''h pr merge 1", "gh pr me''rge 1"]) {
      expect(releaseAction(`echo ${flood(n)} $(${s})`)).toBe("merge");
    }
    // `sh -c '<quoted step>'` is judged by the law test (the merge-base classifier cannot read nested '' either).
    expect(releaseAction(`echo ${flood(n)}; sh -c 'gh pr "merge" 1'`)).toBe("merge");
    for (const s of ["g''it tag v1", "git ta''g v1"]) {
      expect(releaseAction(`echo ${flood(n)} $(${s})`)).toBe("tag");
    }
  });
  test("reads and non-release commands behind the flood stay null", () => {
    expect(releaseAction(`echo ${flood(1000)}; git tag`)).toBeNull();
    expect(releaseAction(`echo ${flood(1000)}; git tag -l`)).toBeNull();
    expect(releaseAction(`echo ${flood(1000)}; gh pr view 1`)).toBeNull();
    expect(releaseAction(`echo ${flood(1000)}; git commit -m x`)).toBeNull();
  });
});

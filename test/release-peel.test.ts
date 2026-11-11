/**
 * A wrapper only wraps the command that follows it; data-taking commands never run their arguments; `sh -n`
 * runs nothing. The hand-built false positives of the challenger must return the merge-base result, while
 * wrapped commands that really run are still detected.
 */
import { describe, test, expect } from "bun:test";
import { releaseAction } from "../src/policy/release-command";
import { baseReleaseAction } from "../src/policy/release-command-base";

describe("no release step where nothing is executed (same as the base)", () => {
  test.each([
    "timeout 5 echo gh pr merge 1", "nice echo git tag v1", "nohup echo git tag v1", "sudo echo gh pr merge 1", "time echo gh pr merge 1", "xargs -I{} echo git tag {}",
    "watch -n 5 echo git tag v1", "env FOO=1 printf '%s' gh pr merge", "echo 'git tag v1' | sh -n", "echo 'gh pr merge 1' | bash --version", "git log --grep 'gh pr merge 1'; bash -l",
    "echo 'gh pr merge 1' | bash -n -c 'x'", "echo 'gh pr merge 1'; sh",
    // challenger-f4-6: a program (not a wrapper) before the verb, extra words after a `-c` script, a redirected producer
    "nohup ./deploy.sh gh pr merge 1", "time bun scripts/notes.ts git tag v1", "timeout 60 npx tool git tag v1", "nice python3 x.py gh pr merge 1", "timeout 5 node -e 'x' gh pr merge 1",
    "nice -n 5 make gh pr merge", "xargs -n1 node x.js gh pr merge", "sudo apt-get install gh pr merge",
    // challenger-f4-7: stdout redirected in any form, or a producer that does not print its words
    "echo 'git tag v1' >&2 | sh", "echo 'git tag v1' 1>&2 | sh", "echo 'gh pr merge 1' >&- | sh", "echo 'gh pr merge 1' >&log | sh", "echo 'gh pr merge 1' &> f | sh", "echo 'gh pr merge 1' &>> f | sh",
    "echo 'gh pr merge 1' >> f | sh", "echo 'gh pr merge 1' >f | sh", "grep -q 'gh pr merge 1' f | sh", "test -n 'git tag v1' | sh", "ls 'git tag v1' | sh", "./gen.sh 'git tag v1' | sh",
    "bash -c 'echo \"$1\"' _ 'gh pr merge 1'", "sh -c 'printf \"%s\\n\" \"$@\"' sh 'git tag v1'", "sh -c 'echo hi' 'git tag v1'", "echo 'git tag v1' > f | sh",
  ])("%s", (c) => {
    expect(releaseAction(c)).toBe(baseReleaseAction(c));
    expect(releaseAction(c)).toBeNull();
  });
});

describe("wrapped commands that really run are still found", () => {
  test.each([
    ["timeout 5 gh pr merge 1", "merge"], ["nice git tag v1", "tag"], ["echo x | sh -c 'gh pr merge 1'", "merge"], ["sudo -u root gh pr merge 1", "merge"], ["xargs -I@ git tag @", "tag"],
    ["env FOO=1 gh pr merge 1", "merge"], ["echo 'gh pr merge 1' | sh", "merge"], ["echo 'git tag v1' | bash -l", "tag"], ["eval 'gh pr merge 1'", "merge"], ["eval gh pr merge 1", "merge"],
    ["flock /tmp/l git tag v1", "tag"], ["time git tag v1", "tag"], ["command gh pr merge 1", "merge"], ["exec gh pr merge 1", "merge"], ["nohup gh pr merge 1", "merge"], ["stdbuf -o0 gh pr merge 1", "merge"],
    ["nohup git tag v1 &", "tag"], ["sudo -u x gh pr merge 1", "merge"], ["env A=1 gh pr merge", "merge"], ["xargs -I{} gh pr merge {}", "merge"], ["sh -c 'gh pr merge 1'", "merge"],
    ["timeout -s KILL 5 git tag v1", "tag"], ["timeout --preserve-status 5 gh pr merge 1", "merge"], ["nice -n 5 gh pr merge 1", "merge"], ["stdbuf -o L git tag v1", "tag"], ["env -u FOO A=1 git tag v1", "tag"],
    ["xargs -n 1 -P 2 gh pr merge", "merge"], ["xargs -I @ sh -c 'gh pr merge @'", "merge"], ["sudo env A=1 git tag v1", "tag"], ["doas -u root gh pr merge 1", "merge"], ["ionice -c 3 git tag v1", "tag"],
    ["taskset -c 0 gh pr merge 1", "merge"], ["taskset 0x1 git tag v1", "tag"], ["caffeinate -t 5 gh pr merge 1", "merge"], ["bash -lc 'git tag v1'", "tag"], ["echo x 2>&1 | sh -c 'gh pr merge 1'", "merge"],
    ["echo 'gh pr merge 1' 2>&1 | sh", "merge"], ["printf 'git tag v1\\n' | bash", "tag"], ["printf '%s\\n' 'gh pr merge 1' | sh", "merge"], ["cat <<< \"gh pr merge 1\" | sh", "merge"],
    ["echo 'git tag v1' 2>/dev/null | sh", "tag"], ["echo -n 'gh pr merge 1' | zsh", "merge"], ["echo gh pr merge 1 | sh", "merge"], ["sh -c 'gh pr merge 1' -n", "merge"], ["bash -c 'git tag v1' x --version", "tag"],
    ["echo 'gh pr merge 1' | sh -s", "merge"],
  ] as const)("%s -> %s", (c, want) => expect(releaseAction(c)).toBe(want));
});

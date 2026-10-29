import { expect, test } from "bun:test";
import { selfApprovalViolation } from "../src/policy/motion/self-approval";
import { invokesRender } from "../src/policy/motion/command";

for (const home of ["~", "$HOME", "${HOME}"]) {
  for (const prefix of ["//", "/./", "///././/"]) {
    test(`1: equivalent home separators ${home}${prefix} retain write protection`, () => {
      const root = `${home}${prefix}.fuse-h*/vid*/*`;
      expect(selfApprovalViolation("Bash", undefined, `cd ${root} && cp /tmp/forged.json approvals.json`)?.kind).toBe("block");
      expect(selfApprovalViolation("Bash", undefined, `ls ${root}`)).toBeNull();
      expect(selfApprovalViolation("Bash", undefined, `cp /tmp/a ${home}${prefix}.cache*/out.txt`)).toBeNull();
      expect(selfApprovalViolation("Bash", undefined, `cp /tmp/a '${root}/approvals.json'`)).toBeNull();
      expect(selfApprovalViolation("Bash", undefined, `cp /tmp/a "${root}/approvals.json"`)).toBeNull();
    });
  }
}

test("1: hidden home globs and variables cannot hide approval writes", () => {
  for (const root of ["~/.fuse-h*/vid*/*", "$HOME/.fuse-h*/vid*/*", "${HOME}/.${DIR}/$SUB/*", "~/.$DIR/$SUB/*"]) {
    expect(selfApprovalViolation("Bash", undefined, `cd ${root} && cp /tmp/forged.json approvals.json`)?.kind).toBe("block");
  }
});

test("1: legitimate reads and writes outside the store remain allowed", () => {
  for (const command of ["cat ~/.fuse-harness/video-motion/k/approvals.json", "ls ~/.fuse-h*/vid*/*", "jq . $HOME/.fuse-harness/video-motion/k/approvals.json", "git status", "cp /tmp/a /tmp/b", "echo x > ~/.cache/out.txt", "cp /tmp/a ~/.cache[ab]/out.txt", "echo x > ~/.cache/*/out.txt"]) {
    expect(selfApprovalViolation("Bash", undefined, command)).toBeNull();
  }
});

test("2: equivalent Bun render paths retain the gate", () => {
  for (const command of ["bun ./scripts/render.ts --stage master", "bun run scripts/render.ts --stage master", "bun run ./scripts/../scripts/render.ts --stage master"]) {
    expect(invokesRender(command, "bun scripts/render.ts")).toBe(true);
  }
  expect(invokesRender("bun scripts/other.ts", "bun scripts/render.ts")).toBe(false);
});

test("1: compound quoting does not hide the expanded home path", () => {
  expect(selfApprovalViolation("Bash", undefined, 'cp /tmp/forged.json "$HOME"/."$DIR"/"$SUB"/k/approvals.json')?.kind).toBe("block");
  expect(selfApprovalViolation("Bash", undefined, 'cat "$HOME"/."$DIR"/"$SUB"/k/approvals.json')).toBeNull();
});

test("1: unquoted escape characters cannot hide the harness glob", () => {
  for (const root of ["~/.fuse\\-h*/mot*/*", "$HOME/.fuse\\-h*/mot*/*"]) {
    expect(selfApprovalViolation("Bash", undefined, `cd ${root} && cp /tmp/forged.json approvals.json`)?.kind).toBe("block");
    expect(selfApprovalViolation("Bash", undefined, `ls ${root}`)).toBeNull();
  }
  expect(selfApprovalViolation("Bash", undefined, "cp /tmp/a ~/.cache\\-x*/out.txt")).toBeNull();
  expect(selfApprovalViolation("Bash", undefined, "cp /tmp/a '~/.cache-x*/out.txt'")).toBeNull();
  expect(selfApprovalViolation("Bash", undefined, "cp /tmp/a '$HOME/.fuse-h*/vid*/*/approvals.json'")).toBeNull();
  expect(selfApprovalViolation("Bash", undefined, 'cp /tmp/a "$HOME/.fuse-h*/vid*/*/approvals.json"')).toBeNull();
});

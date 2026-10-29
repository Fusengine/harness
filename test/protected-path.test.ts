import { test, expect } from "bun:test";
import { protectedPathGuard } from "../src/policy/guards/protected-path";

test("blocks Write/Edit inside protected dirs", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/.claude/plugins/marketplaces/foo/bar.ts" })?.kind).toBe("block");
  expect(protectedPathGuard({ tool: "Edit", filePath: "/x/project/.git/config" })?.kind).toBe("block");
});

test("null for normal source + non-mutating tools", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/project/src/index.ts" })).toBeNull();
  expect(protectedPathGuard({ tool: "Read", filePath: "/x/.claude/plugins/cache/foo.ts" })).toBeNull();
});

test("Bash: a protected path read-source does not count as a write target", () => {
  // Protected fragment is a READ source, the write target is a benign file → allow.
  expect(protectedPathGuard({ tool: "Bash", command: "grep -r x .claude/apex/ > out.txt" })).toBeNull();
  expect(protectedPathGuard({ tool: "Bash", command: "cat .git/config > /dev/null" })).toBeNull();
  // Protected fragment IS the write target → block.
  expect(protectedPathGuard({ tool: "Bash", command: "echo x >> ~/p/.claude/apex/task.json" })?.kind).toBe("block");
  expect(protectedPathGuard({ tool: "Bash", command: "sed -i 's/a/b/' ~/p/.harness/track/t.json" })?.kind).toBe("block");
});

test("`.git` scoping: real .git segment blocks, foo.git/.github do not", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/.git/config" })?.kind).toBe("block");
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/foo.git/readme" })).toBeNull();
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/.github/workflows/ci.yml" })).toBeNull();
});

test("motion store: .fuse-harness/video-motion/ blocked on Write AND Bash redirect; cache/x stays allowed", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/h/.fuse-harness/video-motion/p/approvals.json" })?.kind).toBe("block");
  expect(protectedPathGuard({ tool: "Bash", command: "echo '{}' > /h/.fuse-harness/video-motion/p/approvals.json" })?.kind).toBe("block");
  expect(protectedPathGuard({ tool: "Bash", command: "cat /h/.fuse-harness/video-motion/p/approvals.json > out.txt" })).toBeNull();
  expect(protectedPathGuard({ tool: "Write", filePath: "/h/.fuse-harness/cache/x" })).toBeNull();
  expect(protectedPathGuard({ tool: "Bash", command: "echo 1 > /h/.fuse-harness/cache/x" })).toBeNull();
});

test("cache: only the sessions subtree is protected (safe_paths parity)", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/.fuse-harness/cache/lessons/roots.json" })).toBeNull();
  expect(protectedPathGuard({ tool: "Write", filePath: "/x/.fuse-harness/cache/sessions/s.json" })?.kind).toBe("block");
});

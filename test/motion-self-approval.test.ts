import { expect, test } from "bun:test";
import { selfApprovalViolation as v } from "../src/policy/motion/self-approval";

const STORE = "/Users/u/.fuse-harness/video-motion/k/approvals.json";

test("Write/Edit/MultiEdit/NotebookEdit into the store -> block", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    expect(v(tool, "/Users/u/.fuse-harness/video-motion/x/approvals.json", undefined)?.kind).toBe("block");
  }
  expect(v("Write", "~/.fuse-harness/video-motion/x/approvals.json", undefined)?.kind).toBe("block");
});

test("Write elsewhere / without a path -> null", () => {
  expect(v("Write", "/Users/u/proj/src/a.ts", undefined)).toBeNull();
  expect(v("Write", "/Users/u/.fuse-harness/cache/x.json", undefined)).toBeNull();
  expect(v("Write", undefined, undefined)).toBeNull();
});

test("other tools -> null", () => {
  expect(v("Read", STORE, undefined)).toBeNull();
  expect(v("Grep", STORE, undefined)).toBeNull();
});

test("Bash redirect into the store -> block", () => {
  expect(v("Bash", undefined, "echo '{}' > ~/.fuse-harness/video-motion/k/approvals.json")?.kind).toBe("block");
  expect(v("Bash", undefined, `echo '{}' >> ${STORE}`)?.kind).toBe("block");
});

test("Bash heredoc into the store -> block", () => {
  expect(v("Bash", undefined, `cat > ${STORE} <<EOF\n{"approvals":[]}\nEOF`)?.kind).toBe("block");
});

test("Bash cp/tee/sed -i into the store -> block", () => {
  expect(v("Bash", undefined, `cp /tmp/a.json ${STORE}`)?.kind).toBe("block");
  expect(v("Bash", undefined, `echo x | tee ${STORE}`)?.kind).toBe("block");
  expect(v("Bash", undefined, `sed -i s/a/b/ ${STORE}`)?.kind).toBe("block");
});

test("Bash python / node / cd-then-relative write mentioning the harness dir -> block", () => {
  expect(v("Bash", undefined, `python3 -c "open('${STORE}','w')"`)?.kind).toBe("block");
  expect(v("Bash", undefined, `node -e "require('fs').writeFileSync('${STORE}','{}')"`)?.kind).toBe("block");
  expect(v("Bash", undefined, "cd ~/.fuse-harness/video-motion/k && echo '{}' > approvals.json")?.kind).toBe("block");
  expect(v("Bash", undefined, "cd ~/.fuse-harness/video-motion/k; python3 w.py")?.kind).toBe("block");
});

test("Bash lone & or substitution cannot hide a writer", () => {
  expect(v("Bash", undefined, "cat ~/.fuse-harness/x & rm -rf ~/.fuse-harness/video-motion")?.kind).toBe("block");
  expect(v("Bash", undefined, "cat $(rm ~/.fuse-harness/video-motion/k/approvals.json)")?.kind).toBe("block");
});

test("Bash read-only verbs on the store -> null", () => {
  expect(v("Bash", undefined, "cat ~/.fuse-harness/video-motion/k/approvals.json")).toBeNull();
  expect(v("Bash", undefined, "ls -la ~/.fuse-harness/video-motion | grep k")).toBeNull();
  expect(v("Bash", undefined, `jq . ${STORE}`)).toBeNull();
  expect(v("Bash", undefined, `tail -n 5 ${STORE} && wc -l ${STORE}`)).toBeNull();
});

test("2>&1 is not a separator; a path-lookalike reader is not read-only", () => {
  expect(v("Bash", undefined, "cat ~/.fuse-harness/video-motion/k/approvals.json 2>&1")).toBeNull();
  expect(v("Bash", undefined, "/tmp/cat ~/.fuse-harness/video-motion/k/approvals.json")?.kind).toBe("block");
  expect(v("Bash", undefined, "git status")).toBeNull();
  expect(v("Bash", undefined, "cd ~/.fuse-harness && echo x > video-motion/k/approvals.json")?.kind).toBe("block");
});

test("unrelated Bash commands -> null", () => {
  expect(v("Bash", undefined, "bun test && echo done > out.txt")).toBeNull();
  expect(v("Bash", undefined, 'python3 -c "print(1)"')).toBeNull();
  expect(v("Bash", undefined, undefined)).toBeNull();
});

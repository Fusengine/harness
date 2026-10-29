import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMotionCommand } from "../src/policy/motion/command";
import { criticViolation } from "../src/policy/motion/critic";
import { loadMotionProject } from "../src/policy/motion/project";
import { projectContractViolation } from "../src/policy/motion/project-guard";
import { findSensitive } from "../src/policy/motion/sensitive";
import { protectedPathGuard } from "../src/policy/guards/protected-path";
import { normalizeEvent } from "../src/runtime/normalize";

const root = mkdtempSync(join(tmpdir(), "motion-shell4-"));
const home = join(root, "home");
const review = join(root, ".motion/review");
mkdirSync(review, { recursive: true });
writeFileSync(join(root, ".motion/project.json"), JSON.stringify({ render: "render.sh", masters: ["out/master.mp4"] }));
const project = loadMotionProject(root, home)!;
const guard = (command: string) => projectContractViolation(normalizeEvent("claude-code", { tool_name: "Bash", tool_input: { command } }), root, home);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("C1 renamed renders with literal stage still require the corresponding gate", () => {
  for (const stage of ["draft", "master"] as const) {
    for (const command of [`cp render.sh r2.sh && ./r2.sh --stage ${stage}`, `./arbitrary --stage=${stage}`, `bash -c './renamed --stage ${stage}'`]) {
      expect(classifyMotionCommand(command, root, project).renderStage).toBe(stage);
    }
  }
  expect(classifyMotionCommand("./unrelated --stage stills", root, project).renderStage).toBeUndefined();
});

test("M1 obvious git working-tree mutators cannot rewrite the owner contract", () => {
  for (const command of ["git checkout branch", "git switch other", "git reset --hard", "git read-tree -u HEAD", "git checkout-index -f -a", "git update-index --cacheinfo 100644,abc,.motion/project.json"]) {
    expect(guard(command)).not.toBeNull();
  }
  for (const command of ["git status", "git diff", "git log", "git log --grep switch", "git diff checkout", "git checkout -- src/app.ts", "git reset --soft HEAD~1"]) expect(guard(command)).toBeNull();
});

test("root copy destinations do not imply replacing the project directory", () => {
  for (const command of ["cp x.txt .", "rsync src/ .", "cp -R src .", "cp -t . x.txt", "cp x.txt . && ls ."]) expect(guard(command)).toBeNull();
  for (const command of ["cp evil .motion/project.json", "rsync evil .motion/", "cp -R .motion .", "rm -rf .", "mv . elsewhere"]) expect(guard(command)).not.toBeNull();
});

test("M6 shell positional references are not prices, real amounts remain prices", () => {
  for (const content of ["$1", "$2", "${1}", 'echo "$1"', 'echo "$2"', 'echo "${1}"', "awk '{print $1}'", 'printf "%s" "$1"']) expect(findSensitive(content, [])).toBeNull();
  for (const content of ["$12.50", "$ 1,299", "1299 EUR", "€12", 'echo "$12.50"', 'const price = "$5"']) expect(findSensitive(content, [])).not.toBeNull();
});

test("critic rejects >&file outside review, but keeps harmless descriptor duplication", () => {
  for (const command of ["ls >&out/x.txt", "ls >& out/x.txt", 'ls >&"out/x.txt"', "ls &>out/x.txt"]) expect(criticViolation("Bash", undefined, command, review, root)).not.toBeNull();
  for (const command of ["ls >&2", "ls 2>&1", "ls >&-", 'ls >&"2"', "ls >&.motion/review/list.txt", "ls '>&out/x.txt'"]) expect(criticViolation("Bash", undefined, command, review, root)).toBeNull();
});

test("critic canonicalizes planted output symlinks", () => {
  const outside = join(root, "outside.png");
  writeFileSync(outside, "existing outside output");
  symlinkSync(outside, join(review, "planted.png"));
  expect(criticViolation("Bash", undefined, "ffmpeg -i in.mp4 .motion/review/planted.png", review, root)).not.toBeNull();
  expect(criticViolation("Bash", undefined, "ffmpeg -i in.mp4 -frames:v 1 .motion/review/frame.png", review, root)).toBeNull();
});

test("critic rejects dangling output symlinks whose destination does not exist yet", () => {
  symlinkSync(join(root, "new-outside.png"), join(review, "dangling.png"));
  expect(criticViolation("Bash", undefined, "ffmpeg -i in.mp4 .motion/review/dangling.png", review, root)).not.toBeNull();
});

test("motion keys are protected for every scope like the approval store", () => {
  expect(protectedPathGuard({ tool: "Write", filePath: "/tmp/home/.fuse-harness/video-motion/keys/k.key" })).not.toBeNull();
});

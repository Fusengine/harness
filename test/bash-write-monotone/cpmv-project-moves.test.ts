/**
 * Content that already lives inside the project (renames, backups, project globs and links) and
 * anything unprovable keeps the aa1d13c verdict; outside code is refused only when read on disk.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeGitInit } from "../helpers/monotone-git";
import { guardVerdict } from "../helpers/monotone-guard";

let root = "";
let ext = "";

const verdict = (command: string, cwd: string = root) => guardVerdict(command, cwd);

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fh-cpmv-moves-")));
  root = join(base, "proj");
  ext = join(base, "ext");
  for (const d of ["src/utils", "src/components", "docs", "dist", "public", join("..", "ext", "symcode", "real"), join("..", "ext", "png"), join("..", "ext", "dl", "zipproj")]) mkdirSync(join(root, d), { recursive: true });
  safeGitInit(root);
  for (const f of ["src/utils/a.ts", "src/components/b.tsx", "docs/guide.md"]) writeFileSync(join(root, f), "x\n");
  for (const f of ["symcode/real/index.d.ts", "png/p.png", "dl/photo.jpg", "dl/zipproj/main.js"]) writeFileSync(join(ext, f), "x\n");
  mkdirSync(join(ext, "symonly"), { recursive: true });
  symlinkSync(join(ext, "symcode/real"), join(ext, "symonly/lib")); // a tree whose only content is a link to a directory with code
  symlinkSync(join(ext, "symcode/real/index.d.ts"), join(ext, "evillink.ts"));
  symlinkSync(join(ext, "symcode/real"), join(root, "src/vlink")); // a project link to outside code
});

describe("project content moved or copied inside the project keeps the base verdict", () => {
  test("directory renames and copies, subdirectory cwd, cd", () => {
    for (const cmd of [
      "mv src/utils src/lib", "mv -f src/utils src/helpers", "git mv src/components/btn src/components/button", "cp -r src/components src/components-old", "cp -a src/components src/components.bak",
      "cp -R src src.bak", "cp -r src/utils/ src/lib", "cp -r src/utils/. src/lib", "mv docs manual", "cp -r docs docs2", "cp -r dist build", "cp -r src/utils public/newname",
      "cp -r src/{utils,components} dist/", "cd src && mv utils lib", "(cd src && mv utils lib)",
    ]) expect(verdict(cmd), cmd).toBe("allow");
    expect(verdict("mv utils lib", join(root, "src"))).toBe("allow");
  });
});

describe("globs and trees from outside are judged by what they hold on disk", () => {
  test("clean ones allow; ones holding code are refused", () => {
    for (const cmd of [`cp ${ext}/png/* public/`, `cp ${ext}/dl/* public/`, "cp /tmp/nonexistent-fh-r5/* dist/", `cp -r ${ext}/png public/png`, `cp -r ~/templates/foo ./`]) expect(verdict(cmd), cmd).toBe("allow");
    for (const cmd of [`cp ${ext}/symcode/real/* public/`, `cp ${ext}/symcode/real/*.d.ts public/`, `cp -r ${ext}/dl/* public/`, `mv ${ext}/dl/* public/`, `cp -r ${ext}/symcode public/sc`]) expect(verdict(cmd), cmd).toBe("block");
  });
  test("links as macOS treats them", () => {
    for (const cmd of [`cp -r ${ext}/evillink.ts src/e.ts`, `cp -rL ${ext}/symonly public/`, `cp -r ${ext}/symonly public/s`]) {
      // (a link inside the source tree is copied as a link by cp -r/-R: only -L follows it)
      expect(verdict(cmd), cmd).toBe(cmd.includes("-rL") || cmd.includes("evillink") ? "block" : "allow");
    }
    for (const cmd of ["mv src/vlink src/vlink2", "cp -R src/vlink public/vl", "install -d build dist"]) expect(verdict(cmd), cmd).toBe("allow");
  });
});

describe("GNU -S SUFFIX and --deref prefixes", () => {
  test("a backup suffix is not a source; --deref prefixes follow links", () => {
    for (const cmd of ["cp -S .orig src/utils/a.ts src/utils/a2.ts", "mv -b -S .bak src/utils/a.ts src/utils/a3.ts"]) expect(verdict(cmd), cmd).toBe("allow");
    for (const flag of ["-rL", "-r --deref", "-r --derefer", "--recursive --deref"]) expect(verdict(`cp ${flag} ${ext}/symonly public/`), flag).toBe("block");
  });
});
